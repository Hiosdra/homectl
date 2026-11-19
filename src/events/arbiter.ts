import { join } from "node:path";
import { ensurePrivateDirectoryOnce, withFileLock } from "../control/file-lock";
import { HomectlError } from "../types";
import { readTextIfExists, writeTextAtomic } from "./fs";

export type ArbiterDecision = "approve" | "deny";

export interface DecisionInput {
  operationId: string;
  decision: ArbiterDecision;
  surface: string;
  nonce: string;
  at: number;
  fingerprint: string;
}

export interface DecisionRecord extends DecisionInput {
  decidedAt: number;
}

export type DecisionRejection =
  | "already-decided"
  | "duplicate"
  | "fingerprint-mismatch"
  | "expired"
  | "unknown-operation";

export type DecisionResult =
  | { accepted: true; record: DecisionRecord }
  | { accepted: false; reason: DecisionRejection; record?: DecisionRecord };

interface OperationEntry {
  fingerprint: string;
  expiresAt: number;
  registeredAt: number;
  decision?: DecisionRecord;
}

interface ArbiterFile {
  version: 1;
  operations: Array<{ operationId: string } & OperationEntry>;
}

export interface DecisionArbiterOptions {
  directory: string;
  now?: () => number;
}

const FILE_NAME = "decisions.json";
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE = /^[A-Za-z0-9_-]{16,256}$/;

// Origin-side single-decision arbiter. The decisions file is the source of
// truth: every call re-reads it under the file lock, so two processes or two
// instances on the same directory cannot both win.
export class DecisionArbiter {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly directory: string;

  constructor(options: DecisionArbiterOptions) {
    this.directory = options.directory;
    this.path = join(options.directory, FILE_NAME);
    this.lockPath = join(options.directory, `${FILE_NAME}.lock`);
    this.now = options.now ?? Date.now;
  }

  // Must be called before any decide() for this operation.
  async register(
    operationId: string,
    fingerprint: string,
    expiresAt: number,
  ): Promise<void> {
    assertOperationId(operationId);
    assertText(fingerprint, "fingerprint", 256);
    if (!Number.isFinite(expiresAt))
      throw new HomectlError(2, "expiresAt must be a finite timestamp");
    await this.locked(async () => {
      const operations = await this.read();
      const existing = operations.get(operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new HomectlError(
            2,
            "Operation is already registered with a different fingerprint",
          );
        return;
      }
      operations.set(operationId, {
        fingerprint,
        expiresAt,
        registeredAt: this.now(),
      });
      await this.write(operations);
    });
  }

  async decide(input: DecisionInput): Promise<DecisionResult> {
    assertDecisionInput(input);
    return this.locked(async () => {
      const operations = await this.read();
      const entry = operations.get(input.operationId);
      if (!entry) return { accepted: false, reason: "unknown-operation" };
      if (entry.fingerprint !== input.fingerprint)
        return rejected("fingerprint-mismatch", entry);
      // Replaying the winning decision is idempotent, even after expiry.
      if (entry.decision?.nonce === input.nonce)
        return rejected("duplicate", entry);
      if (entry.decision) return rejected("already-decided", entry);
      if (this.now() > entry.expiresAt)
        return { accepted: false, reason: "expired" };
      const record: DecisionRecord = {
        operationId: input.operationId,
        decision: input.decision,
        surface: input.surface,
        nonce: input.nonce,
        at: input.at,
        fingerprint: input.fingerprint,
        decidedAt: this.now(),
      };
      entry.decision = record;
      await this.write(operations);
      return { accepted: true, record };
    });
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectoryOnce(this.directory);
    return withFileLock(this.lockPath, "Decision arbiter", fn);
  }

  private async read(): Promise<Map<string, OperationEntry>> {
    const text = await readTextIfExists(this.path);
    const operations = new Map<string, OperationEntry>();
    if (text === undefined) return operations;
    let file: ArbiterFile;
    try {
      file = JSON.parse(text) as ArbiterFile;
    } catch {
      throw new HomectlError(5, "Decision state is corrupt");
    }
    if (file.version !== 1 || !Array.isArray(file.operations))
      throw new HomectlError(5, "Decision state is corrupt");
    for (const { operationId, ...entry } of file.operations)
      operations.set(operationId, entry);
    return operations;
  }

  private async write(operations: Map<string, OperationEntry>): Promise<void> {
    const file: ArbiterFile = {
      version: 1,
      operations: [...operations].map(([operationId, entry]) => ({
        operationId,
        ...entry,
      })),
    };
    await writeTextAtomic(this.path, `${JSON.stringify(file)}\n`);
  }
}

function rejected(
  reason: DecisionRejection,
  entry: OperationEntry,
): DecisionResult {
  return entry.decision
    ? { accepted: false, reason, record: entry.decision }
    : { accepted: false, reason };
}

function assertOperationId(value: string): void {
  if (typeof value !== "string" || !OPERATION_ID.test(value))
    throw new HomectlError(2, "Operation id has an invalid format");
}

function assertText(value: unknown, name: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new HomectlError(2, `${name} must be 1-${max} characters`);
}

function assertDecisionInput(input: DecisionInput): void {
  assertOperationId(input.operationId);
  if (input.decision !== "approve" && input.decision !== "deny")
    throw new HomectlError(2, "Decision must be approve or deny");
  assertText(input.surface, "surface", 64);
  if (typeof input.nonce !== "string" || !NONCE.test(input.nonce))
    throw new HomectlError(2, "Nonce must be 16+ base64url characters");
  assertText(input.fingerprint, "fingerprint", 256);
  if (!Number.isFinite(input.at))
    throw new HomectlError(2, "at must be a finite timestamp");
}
