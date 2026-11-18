import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { atomicReplace } from "../platform";
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
  // True when the journal was checked against its separate anchor file.
  anchored?: boolean;
  error?: string;
}

// The anchor records the latest entry the journal is known to contain. It is
// rewritten after every append, so removing entries from the end of the
// journal is detectable even though the chain itself would still verify.
export interface AuditAnchor {
  v: 1;
  seq: number;
  hash: string;
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

// Append-only JSONL journal with a SHA-256 hash chain and a separate anchor.
// Callers must hold the control-plane lock while appending; reads do not.
export class AuditJournal {
  constructor(
    readonly path: string,
    readonly anchorPath: string,
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

  private async readAnchor(): Promise<AuditAnchor | null> {
    let text: string;
    try {
      text = await readFile(this.anchorPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new HomectlError(5, "Audit anchor cannot be read");
    }
    try {
      const anchor = JSON.parse(text) as AuditAnchor;
      if (
        anchor.v !== 1 ||
        !Number.isSafeInteger(anchor.seq) ||
        anchor.seq < 1 ||
        !/^[0-9a-f]{64}$/.test(anchor.hash)
      )
        throw new Error("shape");
      return anchor;
    } catch {
      throw new HomectlError(
        5,
        "Audit anchor is corrupt; preserve the files and investigate",
      );
    }
  }

  private async writeAnchor(anchor: AuditAnchor): Promise<void> {
    const temp = `${this.anchorPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(anchor), { mode: 0o600, flag: "wx" });
    await atomicReplace(temp, this.anchorPath);
  }

  // Chain check plus anchor check.
  async verify(): Promise<ChainCheck> {
    return this.check(await this.read());
  }

  private async check(entries: AuditEntry[]): Promise<ChainCheck> {
    const chain = verifyChain(entries);
    if (!chain.ok) return chain;
    const anchor = await this.readAnchor();
    if (anchor === null)
      return entries.length === 0
        ? { ...chain, anchored: false }
        : {
            ...chain,
            ok: false,
            anchored: false,
            error:
              "audit anchor is missing; the journal cannot be checked for truncation",
          };
    if (entries.length < anchor.seq)
      return {
        ...chain,
        ok: false,
        anchored: true,
        error: `journal has ${entries.length} entries but its anchor records ${anchor.seq}; entries were removed from the end`,
      };
    if (entries[anchor.seq - 1]?.hash !== anchor.hash)
      return {
        ...chain,
        ok: false,
        anchored: true,
        error: `journal diverges from its anchor at entry ${anchor.seq}`,
      };
    return { ...chain, anchored: true };
  }

  async append(event: AuditEvent): Promise<AuditEntry> {
    // Fail closed: never write a payload that looks like secret material.
    if (containsSecretMaterial(JSON.stringify(event)))
      throw new HomectlError(
        5,
        "Audit event refused: secret-like material detected",
      );
    const entries = await this.read();
    const check = await this.check(entries);
    if (!check.ok)
      throw new HomectlError(
        5,
        "Audit journal failed verification; run home-ctl control audit verify",
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
    await this.writeAnchor({ v: 1, seq: entry.seq, hash: entry.hash });
    return entry;
  }
}
