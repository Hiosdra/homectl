// The host keys an address presented when a scan ran (0.3 acceptance). Enrolling a
// machine is allowed only for an address with a recent scan, and planning reads
// this record instead of the network. A record is written only by the owner's scan
// route, which runs after the owner approves an agent's scan, or when the owner
// scans in the panel. The record is local state: it trusts nothing by itself.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../control/file-lock";
import { atomicReplace, protect } from "../platform";

// How long a scan stays good enough to start an enrolment from.
export const SCAN_FRESH_MS = 30 * 60_000;
// The newest records kept. Older addresses drop off; a fresh scan replaces them.
const KEEP = 50;

export interface ScanRecord {
  address: string;
  port: number;
  // When the scan ran (epoch milliseconds).
  at: number;
  keys: { type: string; fingerprint: string }[];
}

export function scanKey(address: string, port: number): string {
  return `${address}:${port}`;
}

// Whether a record is recent at `now`. A record from the future is not recent.
export function isRecentScan(record: ScanRecord, now: number): boolean {
  const age = now - record.at;
  return age >= 0 && age < SCAN_FRESH_MS;
}

export class ScanRecords {
  private readonly path: string;

  constructor(state: string) {
    this.path = join(state, "scan-records.json");
  }

  async load(): Promise<Record<string, ScanRecord>> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, ScanRecord>)
        : {};
    } catch {
      return {};
    }
  }

  // The last scan of an address, however old. Callers decide whether it is recent.
  async last(address: string, port: number): Promise<ScanRecord | undefined> {
    return (await this.load())[scanKey(address, port)];
  }

  async set(record: ScanRecord): Promise<void> {
    await withFileLock(`${this.path}.lock`, "Scan records", async () => {
      const current = await this.load();
      current[scanKey(record.address, record.port)] = record;
      const kept = Object.fromEntries(
        Object.entries(current)
          .sort(([, a], [, b]) => b.at - a.at)
          .slice(0, KEEP),
      );
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(kept), {
        mode: 0o600,
        flag: "wx",
      });
      await protect(temp);
      await atomicReplace(temp, this.path);
    });
  }
}
