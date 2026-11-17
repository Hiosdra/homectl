import { stat } from "node:fs/promises";
import type { AuditJournal } from "./journal";
import type { AuditEntry } from "./types";

export class AuditEntriesCache {
  private cached?: { signature: string; entries: AuditEntry[] };

  async read(
    journal: Pick<AuditJournal, "path" | "read">,
  ): Promise<AuditEntry[]> {
    let signature = "missing";
    try {
      const metadata = await stat(journal.path);
      signature = `${metadata.size}:${metadata.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.cached?.signature === signature)
      return structuredClone(this.cached.entries);
    const entries = await journal.read();
    this.cached = { signature, entries: structuredClone(entries) };
    return entries;
  }
}
