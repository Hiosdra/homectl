import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import { ensurePrivateDirectoryOnce, withFileLock } from "./file-lock";
import type { OperationRecord } from "./types";

export interface ControlState {
  version: 1;
  operations: Record<string, OperationRecord>;
  idempotency: Record<string, { digest: string; operationId: string }>;
  consumedNonces: string[];
}

// Private state directory for the control plane. Files: state.json,
// clients.json, audit.jsonl and a lock file. The lock is exclusive-create, so
// it also serializes separate homectl processes (serve-mcp and the CLI).
export class ControlStore {
  readonly statePath: string;
  readonly clientsPath: string;
  readonly auditPath: string;
  readonly anchorPath: string;
  private readonly lockPath: string;

  constructor(readonly directory: string) {
    this.statePath = join(directory, "state.json");
    this.clientsPath = join(directory, "clients.json");
    this.auditPath = join(directory, "audit.jsonl");
    this.anchorPath = join(directory, "audit.anchor");
    this.lockPath = join(directory, ".lock");
  }

  // Creates and checks the private directory. Called once per process: on
  // Windows each call starts PowerShell to set ACLs.
  async ensureDirectory(): Promise<void> {
    await ensurePrivateDirectoryOnce(this.directory);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, "Control-plane state", fn);
  }

  async loadState(): Promise<ControlState> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          version: 1,
          operations: {},
          idempotency: {},
          consumedNonces: [],
        };
      throw new HomectlError(5, "Control-plane state cannot be read");
    }
    try {
      const state = JSON.parse(text) as ControlState;
      if (
        state.version !== 1 ||
        !state.operations ||
        !state.idempotency ||
        !Array.isArray(state.consumedNonces)
      )
        throw new Error("shape");
      return state;
    } catch {
      throw new HomectlError(
        5,
        "Control-plane state is corrupt; restore it before continuing",
      );
    }
  }

  // Atomic replace: write a unique temp file, then rename. Callers hold the lock.
  async saveState(state: ControlState): Promise<void> {
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await atomicReplace(temp, this.statePath);
  }
}
