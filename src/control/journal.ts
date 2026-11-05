import { appendFile, readFile } from "node:fs/promises";
import { HomectlError } from "../types";
import { canonicalJson, sha256 } from "./canonical";
import { containsSecretMaterial } from "./redact";
import { schemas } from "./schema";
import type { AuditEntry, AuditEvent } from "./types";

export const GENESIS = "0".repeat(64);

export interface ChainCheck {
  ok: boolean;
  entries: number;
  head: string;
  error?: string;
}

type EntryBody = Omit<AuditEntry, "hash">;

function chainHash(body: EntryBody): string {
  return sha256(canonicalJson(body));
}

// Recomputes the hash chain. Reports only the first failing sequence number,
// never entry contents.
export function verifyChain(entries: AuditEntry[]): ChainCheck {
  let prev = GENESIS;
  for (const [index, entry] of entries.entries()) {
    const seq = index + 1;
    const fail = (error: string): ChainCheck => ({
      ok: false,
      entries: entries.length,
      head: prev,
      error: `${error} at entry ${seq}`,
    });
    if (!schemas.auditEntry(entry)) return fail("schema violation");
    if (entry.seq !== seq) return fail("sequence break");
    if (entry.prev !== prev) return fail("chain link broken");
    const { hash, ...body } = entry;
    if (chainHash(body) !== hash) return fail("hash mismatch");
    prev = hash;
  }
  return { ok: true, entries: entries.length, head: prev };
}

// Append-only JSONL journal with a SHA-256 hash chain. Callers must hold the
// control-plane lock while appending; reads do not require it.
export class AuditJournal {
  constructor(
    readonly path: string,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new HomectlError(5, "Audit journal cannot be read");
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          throw new HomectlError(
            5,
            `Audit journal line ${index + 1} is not valid JSON`,
          );
        }
      });
  }

  async verify(): Promise<ChainCheck> {
    return verifyChain(await this.read());
  }

  async append(event: AuditEvent): Promise<AuditEntry> {
    // Fail closed: never write a payload that looks like secret material.
    if (containsSecretMaterial(JSON.stringify(event)))
      throw new HomectlError(
        5,
        "Audit event refused: secret-like material detected",
      );
    const entries = await this.read();
    const check = verifyChain(entries);
    if (!check.ok)
      throw new HomectlError(
        5,
        "Audit journal failed verification; run homectl control audit verify",
      );
    const last = entries.at(-1);
    const body: EntryBody = {
      v: 1,
      seq: (last?.seq ?? 0) + 1,
      at: new Date(this.clock()).toISOString(),
      prev: last?.hash ?? GENESIS,
      event,
    };
    const entry: AuditEntry = { ...body, hash: chainHash(body) };
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }
}
