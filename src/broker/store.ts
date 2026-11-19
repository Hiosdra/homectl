// Durable broker state: operations and tasks. One JSON file, replaced
// atomically under a cross-process lock. The daemon is the only writer in
// normal operation; the lock protects against a second process (tests, a
// crashed daemon being replaced).
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectoryOnce, withFileLock } from "../control/file-lock";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import { type BrokerState, FINAL_STATES } from "./types";

// Finished operations kept for history in this file (older ones live in the
// audit journal / backups).
export const MAX_FINISHED_OPERATIONS = 2000;

export class BrokerStore {
  readonly statePath: string;
  private readonly lockPath: string;

  constructor(readonly directory: string) {
    this.statePath = join(directory, "broker-state.json");
    this.lockPath = join(directory, ".broker-state.lock");
  }

  async load(): Promise<BrokerState> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, operations: {}, tasks: {} };
      throw new HomectlError(5, "Broker state cannot be read");
    }
    try {
      const state = JSON.parse(text) as BrokerState;
      if (
        state.version !== 1 ||
        typeof state.operations !== "object" ||
        typeof state.tasks !== "object"
      )
        throw new Error("shape");
      return state;
    } catch {
      throw new HomectlError(
        5,
        "Broker state is corrupt; restore it from backups before continuing",
      );
    }
  }

  private async save(state: BrokerState): Promise<void> {
    const finished = Object.values(state.operations)
      .filter((op) => FINAL_STATES.includes(op.state))
      .sort(
        (a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt),
      );
    for (const op of finished.slice(MAX_FINISHED_OPERATIONS))
      delete state.operations[op.id];
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await atomicReplace(temp, this.statePath);
  }

  // Read-modify-write under the lock. `fn` returns the value to hand back;
  // the state is saved only when `fn` resolves.
  async update<T>(fn: (state: BrokerState) => Promise<T> | T): Promise<T> {
    await ensurePrivateDirectoryOnce(this.directory);
    return withFileLock(this.lockPath, "Broker state", async () => {
      const state = await this.load();
      const result = await fn(state);
      await this.save(state);
      return result;
    });
  }
}
