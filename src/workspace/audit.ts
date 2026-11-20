// Audit trail for owner-authorised workspace actions (homelab #21 §6, D6A).
// One JSON object per line, each chained to the previous line by SHA-256, so
// editing, reordering or dropping an earlier line fails verification. Entries
// carry identifiers, counts, reasons and outcomes only, never backup contents.
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { canonicalJson } from "../backup";
import { HomectlError } from "../types";

export const GENESIS_HASH = "0".repeat(64);

export type AuditFields = Record<string, string | number | boolean>;

export type AuditEntry = AuditFields & {
  seq: number;
  at: number;
  action: string;
  prev: string;
  hash: string;
};

export interface AuditCheck {
  ok: boolean;
  entries: number;
  error?: string;
}

function digest(body: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

// Recomputes the chain. Reports the first failing line number, not contents.
export function verifyAudit(entries: AuditEntry[]): AuditCheck {
  let prev = GENESIS_HASH;
  for (const [index, entry] of entries.entries()) {
    const { hash, ...body } = entry;
    if (entry.seq !== index + 1)
      return {
        ok: false,
        entries: index,
        error: `sequence break at ${index + 1}`,
      };
    if (entry.prev !== prev)
      return {
        ok: false,
        entries: index,
        error: `chain broken at ${index + 1}`,
      };
    if (digest(body) !== hash)
      return {
        ok: false,
        entries: index,
        error: `hash mismatch at ${index + 1}`,
      };
    prev = hash;
  }
  return { ok: true, entries: entries.length };
}

export class WorkspaceAudit {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new HomectlError(5, "Workspace audit trail cannot be read");
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
            `Workspace audit line ${index + 1} is not valid JSON`,
          );
        }
      });
  }

  // Appends are serialised in-process. The file is small and written rarely
  // (owner decryptions, restores), so each append re-reads the chain head.
  append(action: string, fields: AuditFields = {}): Promise<AuditEntry> {
    const next = this.tail.then(async () => {
      const entries = await this.read();
      const prev = entries.at(-1)?.hash ?? GENESIS_HASH;
      const body = {
        ...fields,
        seq: entries.length + 1,
        at: this.now(),
        action,
        prev,
      };
      const entry = { ...body, hash: digest(body) } as AuditEntry;
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
      return entry;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  async verify(): Promise<AuditCheck> {
    return verifyAudit(await this.read());
  }
}
