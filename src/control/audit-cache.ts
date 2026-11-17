import { stat } from "node:fs/promises";
import type { AuditJournal } from "./journal";
import type { AuditEntry } from "./types";

export class AuditEntriesCache {
  private cached?: { signature: string; entries: readonly AuditEntry[] };

  async read(
    journal: Pick<AuditJournal, "path" | "read">,
  ): Promise<readonly AuditEntry[]> {
    let signature = "missing";
    try {
      const metadata = await stat(journal.path);
      signature = `${metadata.size}:${metadata.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.cached?.signature === signature) return this.cached.entries;
    const entries = await journal.read();
    const cachedEntries = structuredClone(entries);
    for (const entry of cachedEntries) {
      if (entry.event.argv) Object.freeze(entry.event.argv);
      Object.freeze(entry.event);
      Object.freeze(entry);
    }
    Object.freeze(cachedEntries);
    this.cached = { signature, entries: cachedEntries };
    return cachedEntries;
  }
}
