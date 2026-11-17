import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditEntriesCache } from "../src/control/audit-cache";
import type { AuditEntry } from "../src/control/types";

test("audit entry cache reuses size and mtime and refreshes after a write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homectl-audit-cache-"));
  const path = join(directory, "audit.jsonl");
  await writeFile(path, "one");
  let reads = 0;
  const cache = new AuditEntriesCache();
  const journal = {
    path,
    read: async (): Promise<AuditEntry[]> => {
      const seq = ++reads;
      return [
        {
          v: 1,
          seq,
          at: new Date(0).toISOString(),
          prev: "0".repeat(64),
          hash: "1".repeat(64),
          event: { event: "client.created", client: "cache-test" },
        },
      ];
    },
  };
  try {
    expect((await cache.read(journal)).map((entry) => entry.seq)).toEqual([1]);
    expect((await cache.read(journal)).map((entry) => entry.seq)).toEqual([1]);
    expect(reads).toBe(1);
    await writeFile(path, "two entries");
    expect((await cache.read(journal)).map((entry) => entry.seq)).toEqual([2]);
    expect(reads).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
