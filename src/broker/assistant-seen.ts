// When each assistant last reached the broker, for the setup checklist only (audit
// C5: "connected" means a successful call). The registry is not written on every
// agent request, so this keeps its own small file, broker/assistant-seen.json
// (mode 0600): client ids and millisecond timestamps. It grants nothing.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { atomicReplace, protect } from "../platform";

// Saves are throttled: an approximate "last seen" is good enough for a checklist.
const SAVE_EVERY_MS = 60_000;

export class AssistantSeen {
  private seen: Record<string, number> = {};
  private lastSave = 0;
  private loading: Promise<void>;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.loading = this.load();
  }

  // Called after each successful agent call.
  note(id: string): void {
    const at = this.now();
    const isNew = !(id in this.seen);
    this.seen[id] = at;
    if (!isNew && at - this.lastSave < SAVE_EVERY_MS) return;
    this.lastSave = at;
    this.saving = this.saving.then(() => this.save()).catch(() => undefined);
  }

  async lastSeen(id: string): Promise<number | undefined> {
    await this.loading;
    return this.seen[id];
  }

  private async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as {
        seen?: Record<string, unknown>;
      };
      for (const [id, at] of Object.entries(value.seen ?? {}))
        if (typeof at === "number" && Number.isSafeInteger(at))
          this.seen[id] = at;
    } catch {
      // Missing or unreadable: no assistant has been seen yet.
    }
  }

  private async save(): Promise<void> {
    // Never write over the file before what it already holds is read back.
    await this.loading;
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, seen: this.seen }), {
      mode: 0o600,
      flag: "wx",
    });
    await atomicReplace(temp, this.path);
    await protect(this.path);
  }
}
