import { randomUUID } from "node:crypto";
import { appendFile, chown, readFile, stat, writeFile } from "node:fs/promises";
import { atomicReplace, protect } from "../platform";
import { HomectlError } from "../types";
import { canonicalJson, sha256 } from "./canonical";
import { controlStateDirectory } from "./paths";
import { containsSecretMaterial, normalizeAuditArgv } from "./redact";
import { schemas } from "./schema";
import { ControlStore } from "./store";
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

type VerifiedTail = {
  journalSignature: string;
  anchorSignature: string;
  seq: number;
  hash: string;
};

const verifiedTails = new Map<string, VerifiedTail>();

async function fileSignature(path: string): Promise<string> {
  try {
    const metadata = await stat(path);
    return `${metadata.size}:${metadata.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function normalizeAuditEvent(event: AuditEvent): AuditEvent {
  const normalized = { ...event };
  if (typeof normalized.argv !== "undefined" && Array.isArray(normalized.argv))
    normalized.argv = normalizeAuditArgv(normalized.argv);
  if (typeof normalized.reason === "string")
    normalized.reason = normalized.reason.slice(0, 120);
  if (typeof normalized.deviceName === "string")
    normalized.deviceName = normalized.deviceName.slice(0, 100);
  return normalized;
}

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
    await protect(temp);
    if (process.platform !== "win32") {
      let owner: { uid: number; gid: number } | undefined;
      for (const path of [this.anchorPath, this.path]) {
        try {
          owner = await stat(path);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (owner) {
        const temporary = await stat(temp);
        if (temporary.uid !== owner.uid || temporary.gid !== owner.gid)
          await chown(temp, owner.uid, owner.gid);
      }
    }
    await atomicReplace(temp, this.anchorPath);
  }

  private cacheKey(): string {
    return `${this.path}\0${this.anchorPath}`;
  }

  private async signatures() {
    const [journalSignature, anchorSignature] = await Promise.all([
      fileSignature(this.path),
      fileSignature(this.anchorPath),
    ]);
    return { journalSignature, anchorSignature };
  }

  private rememberTail(
    entries: AuditEntry[],
    signatures: { journalSignature: string; anchorSignature: string },
  ) {
    const last = entries.at(-1);
    verifiedTails.set(this.cacheKey(), {
      ...signatures,
      seq: last?.seq ?? 0,
      hash: last?.hash ?? GENESIS,
    });
  }

  // Chain check plus anchor check.
  async verify(): Promise<ChainCheck> {
    const before = await this.signatures();
    const entries = await this.read();
    const check = await this.check(entries);
    const after = await this.signatures();
    if (
      check.ok &&
      before.journalSignature === after.journalSignature &&
      before.anchorSignature === after.anchorSignature
    )
      this.rememberTail(entries, after);
    return check;
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
    const normalizedEvent = normalizeAuditEvent(event);
    if (!schemas.auditEvent(normalizedEvent))
      throw new HomectlError(
        5,
        "Audit event refused: schema validation failed",
      );
    // Fail closed: never write a payload that looks like secret material.
    if (containsSecretMaterial(JSON.stringify(normalizedEvent)))
      throw new HomectlError(
        5,
        "Audit event refused: secret-like material detected",
      );
    const signatures = await this.signatures();
    const key = this.cacheKey();
    let tail = verifiedTails.get(key);
    if (
      !tail ||
      tail.journalSignature !== signatures.journalSignature ||
      tail.anchorSignature !== signatures.anchorSignature
    ) {
      const entries = await this.read();
      const check = await this.check(entries);
      const after = await this.signatures();
      if (
        !check.ok ||
        after.journalSignature !== signatures.journalSignature ||
        after.anchorSignature !== signatures.anchorSignature
      )
        throw new HomectlError(
          5,
          "Audit journal failed verification; run home-ctl control audit verify",
        );
      this.rememberTail(entries, after);
      tail = verifiedTails.get(key);
    }
    const body: EntryBody = {
      v: 1,
      seq: (tail?.seq ?? 0) + 1,
      at: new Date(this.clock()).toISOString(),
      prev: tail?.hash ?? GENESIS,
      event: normalizedEvent,
    };
    const entry: AuditEntry = { ...body, hash: chainHash(body) };
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await this.writeAnchor({ v: 1, seq: entry.seq, hash: entry.hash });
    this.rememberTail([entry], await this.signatures());
    return entry;
  }
}

// Normal CLI, panel and peer operations share the control plane's existing
// journal. The audit file is deliberately absent from peer snapshots.
export async function appendLocalAudit(
  inventoryPath: string,
  event: AuditEvent,
): Promise<AuditEntry> {
  const store = new ControlStore(controlStateDirectory(inventoryPath));
  await store.ensureDirectory();
  const journal = new AuditJournal(store.auditPath, store.anchorPath);
  return store.withLock(() => journal.append(event));
}
