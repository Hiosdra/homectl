// Per-origin hash-chained logs (ADR-0002, stage c). Every device keeps a log of
// the signed records it originated and the records it relayed from each origin.
// A receiver stores the last (seq, hash) it verified per origin. A later batch
// from that origin must extend the chain; if it shows a lower head, a changed
// hash at a known sequence, or a broken link, the replica is reported as
// truncated or rewritten and the origin is not trusted further.
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical";

export const ORIGIN_GENESIS = "0".repeat(64);

export interface LogEntry {
  seq: number;
  hash: string;
  envelope: unknown;
}

export interface Checkpoint {
  seq: number;
  hash: string;
}

export function chainHash(prev: string, envelope: unknown): string {
  return createHash("sha256")
    .update(prev)
    .update(canonicalJson(envelope))
    .digest("hex");
}

export function appendEntry(log: LogEntry[], envelope: unknown): LogEntry {
  const last = log.at(-1);
  const prev = last?.hash ?? ORIGIN_GENESIS;
  const entry: LogEntry = {
    seq: (last?.seq ?? 0) + 1,
    hash: chainHash(prev, envelope),
    envelope,
  };
  log.push(entry);
  return entry;
}

export type Continuity =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; reason: "truncated" | "rewritten" | "gap" };

// Verifies a batch against the receiver's checkpoint for this origin.
// Entries at or below the checkpoint are compared, not re-applied.
export function checkContinuity(
  known: Checkpoint | undefined,
  head: Checkpoint,
  entries: LogEntry[],
): Continuity {
  if (known) {
    if (head.seq < known.seq) return { ok: false, reason: "truncated" };
    if (head.seq === known.seq && head.hash !== known.hash)
      return { ok: false, reason: "rewritten" };
  }
  let prev = known?.hash ?? ORIGIN_GENESIS;
  let expected = (known?.seq ?? 0) + 1;
  for (const entry of entries) {
    if (entry.seq < expected) {
      // Already verified: it must match what we stored.
      if (known && entry.seq === known.seq && entry.hash !== known.hash)
        return { ok: false, reason: "rewritten" };
      continue;
    }
    if (entry.seq !== expected) return { ok: false, reason: "gap" };
    if (chainHash(prev, entry.envelope) !== entry.hash)
      return { ok: false, reason: "rewritten" };
    prev = entry.hash;
    expected += 1;
  }
  const verifiedSeq = expected - 1;
  if (verifiedSeq < head.seq) return { ok: false, reason: "gap" };
  if (verifiedSeq === head.seq && prev !== head.hash)
    return { ok: false, reason: "rewritten" };
  return { ok: true, checkpoint: { seq: head.seq, hash: head.hash } };
}
