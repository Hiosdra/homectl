import { stat } from "node:fs/promises";
import { type AuditHistoryRecord, auditHistoryRows } from "./audit-view";
import type { AuditJournal } from "./journal";
import type { AuditEntry } from "./types";

export class AuditEntriesCache {
  private cached?: { signature: string; entries: readonly AuditEntry[] };
  private cachedRows?: {
    entries: readonly AuditEntry[];
    names: string;
    rows: readonly AuditHistoryRecord[];
  };

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

  async rows(
    journal: Pick<AuditJournal, "path" | "read">,
    names: Record<string, string>,
  ): Promise<readonly AuditHistoryRecord[]> {
    const entries = await this.read(journal);
    const namesKey = JSON.stringify(
      Object.entries(names).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (
      this.cachedRows?.entries === entries &&
      this.cachedRows.names === namesKey
    )
      return this.cachedRows.rows;
    const rows = auditHistoryRows(entries, names).map(({ row, ...record }) => ({
      ...record,
      row: {
        ...row,
        ...(row.argv ? { argv: [...row.argv] } : {}),
      },
    }));
    for (const { row } of rows) {
      if (row.argv) Object.freeze(row.argv);
      Object.freeze(row);
    }
    Object.freeze(rows);
    this.cachedRows = { entries, names: namesKey, rows };
    return rows;
  }
}
