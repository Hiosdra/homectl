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
          event: {
            event: "client.created",
            client: "cache-test",
            argv: ["command"],
          },
        },
      ];
    },
  };
  try {
    const first = await cache.read(journal);
    const cached = await cache.read(journal);
    expect(first.map((entry) => entry.seq)).toEqual([1]);
    expect(cached.map((entry) => entry.seq)).toEqual([1]);
    expect(cached).toBe(first);
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached[0])).toBe(true);
    expect(Object.isFrozen(cached[0]?.event)).toBe(true);
    expect(Object.isFrozen(cached[0]?.event.argv)).toBe(true);
    expect(reads).toBe(1);
    await writeFile(path, "two entries");
    expect((await cache.read(journal)).map((entry) => entry.seq)).toEqual([2]);
    expect(reads).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("derived audit rows are cached with the journal entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homectl-audit-rows-"));
  const path = join(directory, "audit.jsonl");
  await writeFile(path, "initial");
  let reads = 0;
  let sequence = 1;
  const cache = new AuditEntriesCache();
  const journal = {
    path,
    read: async (): Promise<AuditEntry[]> => {
      reads++;
      return [
        {
          v: 1,
          seq: sequence,
          at: new Date(0).toISOString(),
          prev: "0".repeat(64),
          hash: "1".repeat(64),
          event: {
            event: "command.refused",
            op: "execute",
            operationId: `cached-operation-${sequence}`,
            host: "nas",
            argv: ["rm", "fixture"],
            policyDecision: "refused",
            reason: "policy-refused",
          },
        },
      ];
    },
  };
  try {
    const first = await cache.rows(journal, {});
    const cached = await cache.rows(journal, {});
    expect(first).toBe(cached);
    expect(first).toHaveLength(1);
    expect(reads).toBe(1);

    sequence++;
    await writeFile(path, "updated journal entries");
    const refreshed = await cache.rows(journal, {});
    expect(refreshed).not.toBe(first);
    expect(reads).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
