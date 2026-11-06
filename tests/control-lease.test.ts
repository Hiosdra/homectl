import { describe, expect, test } from "bun:test";
import {
  appendEntry,
  type Checkpoint,
  checkContinuity,
  type LogEntry,
} from "../src/control/checkpoint";
import {
  backoffMs,
  LEASE_MS,
  leaseCheck,
  SKEW_MS,
  takeoverWindow,
} from "../src/control/lease";

describe("owner lease", () => {
  test("no paired peers means no lease gate", () => {
    expect(leaseCheck([], {}, 1_000_000)).toEqual({ ok: true });
  });

  test("the owner may execute only with a sync with every peer inside the lease", () => {
    const now = 1_000_000;
    expect(leaseCheck(["b", "c"], { b: now - 1, c: now - 10 }, now)).toEqual({
      ok: true,
    });
    const stale = leaseCheck(
      ["b", "c"],
      { b: now - LEASE_MS - 1, c: now },
      now,
    );
    expect(stale).toEqual({ ok: false, waitingFor: ["b"] });
    // A peer never synced is also outstanding.
    expect(leaseCheck(["b"], {}, now)).toEqual({
      ok: false,
      waitingFor: ["b"],
    });
  });

  test("takeover opens only after lease plus skew, and never without a known last contact", () => {
    const seen = 1_000_000;
    expect(
      takeoverWindow(undefined, seen + 10 * LEASE_MS, LEASE_MS, SKEW_MS)
        .allowed,
    ).toBe(false);
    expect(
      takeoverWindow(seen, seen + LEASE_MS, LEASE_MS, SKEW_MS).allowed,
    ).toBe(false);
    const window = takeoverWindow(
      seen,
      seen + LEASE_MS + SKEW_MS,
      LEASE_MS,
      SKEW_MS,
    );
    expect(window).toEqual({ allowed: true, at: seen + LEASE_MS + SKEW_MS });
  });

  test("backoff grows and is capped", () => {
    expect(backoffMs(0)).toBe(5_000);
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(3)).toBe(40_000);
    expect(backoffMs(100)).toBe(300_000);
  });
});

describe("per-origin checkpoints", () => {
  const build = () => {
    const log: LogEntry[] = [];
    for (const n of [1, 2, 3]) appendEntry(log, { kind: "op", n });
    const head = log.at(-1) as LogEntry;
    return { log, head: { seq: head.seq, hash: head.hash } };
  };

  test("a fresh receiver verifies the whole chain", () => {
    const { log, head } = build();
    expect(checkContinuity(undefined, head, log)).toEqual({
      ok: true,
      checkpoint: head,
    });
  });

  test("an extension after a checkpoint verifies from that point", () => {
    const { log, head } = build();
    const known: Checkpoint = { seq: 1, hash: log[0]?.hash ?? "" };
    expect(checkContinuity(known, head, log.slice(1))).toEqual({
      ok: true,
      checkpoint: head,
    });
  });

  test("a rewritten entry is detected", () => {
    const { log, head } = build();
    const forged = log.map((e, i) =>
      i === 1 ? { ...e, envelope: { kind: "op", n: 99 } } : e,
    );
    expect(checkContinuity(undefined, head, forged)).toEqual({
      ok: false,
      reason: "rewritten",
    });
  });

  test("a head that moved backwards from the checkpoint is a truncation", () => {
    const { log, head } = build();
    const known: Checkpoint = { seq: 3, hash: head.hash };
    const shorter = { seq: 2, hash: log[1]?.hash ?? "" };
    expect(checkContinuity(known, shorter, log.slice(0, 2))).toEqual({
      ok: false,
      reason: "truncated",
    });
  });

  test("the same sequence with a different hash is a rewrite, not a truncation", () => {
    const { head } = build();
    const known: Checkpoint = { seq: 3, hash: "f".repeat(64) };
    expect(checkContinuity(known, head, [])).toEqual({
      ok: false,
      reason: "rewritten",
    });
  });

  test("a batch that stops short of its own head is a gap", () => {
    const { log, head } = build();
    expect(checkContinuity(undefined, head, log.slice(0, 2))).toEqual({
      ok: false,
      reason: "gap",
    });
  });
});
