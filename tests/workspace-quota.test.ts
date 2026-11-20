// Per-client chunk storage quota on the workspace server (homelab #21 §6).
// An upload over the limit is refused with a clear error; a chunk the client
// already holds is never charged twice; usage survives a server restart.
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CHUNK_SIZE, prune } from "../src/backup";
import { BackupStore } from "../src/backup/store";
import { WorkspaceServer } from "../src/workspace/server";
import { DEFAULT_CLIENT_QUOTA_BYTES } from "../src/workspace/quota";
import { backupClientId } from "../src/workspace/state";
import {
  clientId,
  fixture,
  type Harness,
  link,
  stepUp,
} from "./workspace-helpers";

interface ClientView {
  id: string;
  backup: {
    latestSeq: number | null;
    storedBytes: number;
    quota: { usedBytes: number; limitBytes: number };
  };
}

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function clientView(harness: Harness): Promise<ClientView> {
  const id = await clientId(harness);
  const rows = (await harness.server.owner(
    "/v1/owner/workspace/clients",
    {},
    stepUp,
  )) as ClientView[];
  const row = rows.find((item) => item.id === id);
  if (!row) throw new Error("client missing from the listing");
  return row;
}

test("the default quota is one GiB per client", () => {
  expect(DEFAULT_CLIENT_QUOTA_BYTES).toBe(1024 * 1024 * 1024);
});

test("an upload over the quota is refused with a clear error", async () => {
  // Two sealed 1 MiB chunks fit; the third does not.
  h = await fixture({ quotaBytes: 2 * CHUNK_SIZE + 1024 });
  await link(h);
  h.files = [{ path: "inventory.yaml", data: randomBytes(3 * CHUNK_SIZE) }];

  await expect(h.client.backupOnce()).rejects.toThrow(
    "Backup storage quota reached",
  );

  const view = await clientView(h);
  expect(view.backup.latestSeq).toBeNull();
  expect(view.backup.quota.limitBytes).toBe(2 * CHUNK_SIZE + 1024);
  expect(view.backup.quota.usedBytes).toBeLessThanOrEqual(
    view.backup.quota.limitBytes,
  );
  const link0 = await h.clientLink();
  expect(link0.backup.lastError).toContain("Backup storage quota reached");
});

test("a chunk the client already holds is not charged again", async () => {
  h = await fixture({ quotaBytes: CHUNK_SIZE + 1024 });
  await link(h);
  h.files = [{ path: "inventory.yaml", data: randomBytes(CHUNK_SIZE) }];

  expect((await h.client.backupOnce())?.uploaded).toBe(1);
  // The same content needs no new chunk, so it fits even at the limit.
  const second = await h.client.backupOnce();
  expect(second?.uploaded).toBe(0);
  expect(second?.reused).toBe(1);

  const view = await clientView(h);
  expect(view.backup.latestSeq).toBe(2);
  expect(view.backup.quota.usedBytes).toBe(view.backup.storedBytes);
});

test("usage is rebuilt from the retained snapshots after a restart", async () => {
  h = await fixture({ quotaBytes: 10 * CHUNK_SIZE });
  await link(h);
  h.files = [{ path: "inventory.yaml", data: randomBytes(CHUNK_SIZE + 10) }];
  await h.client.backupOnce();
  const before = await clientView(h);
  expect(before.backup.quota.usedBytes).toBe(before.backup.storedBytes);

  const restarted = new WorkspaceServer(h.serverDir, {
    quotaBytes: 10 * CHUNK_SIZE,
  });
  const rows = (await restarted.owner(
    "/v1/owner/workspace/clients",
    {},
    stepUp,
  )) as ClientView[];
  expect(rows[0]?.backup.quota.usedBytes).toBe(before.backup.quota.usedBytes);
});

test("a prune releases the chunks it removes, without waiting for a restart", async () => {
  h = await fixture({ quotaBytes: 10 * CHUNK_SIZE });
  await link(h);
  for (let round = 0; round < 3; round += 1) {
    h.files = [{ path: "inventory.yaml", data: randomBytes(CHUNK_SIZE) }];
    await h.client.backupOnce();
  }
  const before = await clientView(h);
  expect(before.backup.quota.usedBytes).toBe(before.backup.storedBytes);

  // The same store root as the server: a prune here is an in-process prune.
  const store = new BackupStore(join(h.serverDir, "workspace-backups"));
  const stats = await prune(store, backupClientId(await clientId(h)), {
    keepMs: 0,
    now: Date.now() + 60_000,
    keepLatestVerified: true,
    graceMs: 0,
  });
  expect(stats.removedManifests).toBe(2);
  expect(stats.removedChunks).toBe(2);

  const after = await clientView(h);
  expect(after.backup.quota.usedBytes).toBe(after.backup.storedBytes);
  expect(after.backup.quota.usedBytes).toBeLessThan(
    before.backup.quota.usedBytes,
  );
});
