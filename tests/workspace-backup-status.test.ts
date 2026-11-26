// Backup health in the owner's client listing (homelab #21 §6): lag between
// what a client reports and what the server holds, stored size, retention, and
// a server-triggered "backup now" that a client picks up on its next sync.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { backupClientId } from "../src/workspace/state";
import {
  clientId,
  fixture,
  type Harness,
  link,
  stepUp,
} from "./workspace-helpers";

interface Row {
  id: string;
  stale: boolean;
  backupRequested: boolean;
  backup: {
    latestSeq: number | null;
    latestAt: number | null;
    clientSeq: number | null;
    lagSnapshots: number | null;
    lagSeconds: number | null;
    clientLastError: string | null;
    snapshots: number;
    storedBytes: number;
    quota: { usedBytes: number; limitBytes: number };
    retention: {
      snapshots: number;
      oldestAt: number | null;
      scheduled: boolean;
    };
  };
}

let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

async function rows(): Promise<Row[]> {
  return (await h.server.owner(
    "/v1/owner/workspace/clients",
    {},
    stepUp,
  )) as Row[];
}

async function row(): Promise<Row> {
  const id = await clientId(h);
  const found = (await rows()).find((item) => item.id === id);
  if (!found) throw new Error("client missing from the listing");
  return found;
}

test("the listing shows seq, lag, stored size, quota and retention", async () => {
  await link(h);
  h.files = [{ path: "inventory.yaml", data: randomBytes(4096) }];
  await h.client.backupOnce();
  await h.client.syncOnce();

  const r = await row();
  expect(r.backup.latestSeq).toBe(1);
  expect(r.backup.clientSeq).toBe(1);
  expect(r.backup.lagSnapshots).toBe(0);
  expect(typeof r.backup.lagSeconds).toBe("number");
  expect(r.backup.snapshots).toBe(1);
  expect(r.backup.storedBytes).toBeGreaterThan(4096);
  expect(r.backup.quota.usedBytes).toBe(r.backup.storedBytes);
  expect(r.backup.quota.limitBytes).toBeGreaterThan(0);
  expect(r.backup.retention).toMatchObject({ snapshots: 1, scheduled: false });
  expect(typeof r.backup.retention.oldestAt).toBe("number");
});

test("lag shows snapshots the client holds that the server has lost", async () => {
  await link(h);
  h.files = [{ path: "inventory.yaml", data: randomBytes(512) }];
  await h.client.backupOnce();
  await h.client.syncOnce();

  // The server loses its history for this client; the client's report stays.
  const id = await clientId(h);
  await rm(
    join(h.serverDir, "workspace-backups", "manifests", backupClientId(id)),
    {
      recursive: true,
      force: true,
    },
  );

  const r = await row();
  expect(r.backup.latestSeq).toBeNull();
  expect(r.backup.clientSeq).toBe(1);
  expect(r.backup.lagSnapshots).toBe(1);
});

test("the client's last backup error reaches the owner's listing", async () => {
  await link(h);
  h.files = [{ path: "inventory.yaml", data: randomBytes(512) }];
  await h.client.backupOnce();
  // Force a failure: the next run cannot build a snapshot from these files.
  h.files = [
    { path: "inventory.yaml", data: randomBytes(64) },
    { path: "inventory.yaml", data: randomBytes(64) },
  ];
  await expect(h.client.backupOnce()).rejects.toThrow();
  await h.client.syncOnce();

  expect((await row()).backup.clientLastError).toBeTruthy();
});

test("a requested backup runs on the client's next sync, once", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = [{ path: "inventory.yaml", data: randomBytes(512) }];
  await h.server.owner(
    "/v1/owner/workspace/backup-request",
    { client: id },
    stepUp,
  );
  expect((await row()).backupRequested).toBe(true);

  await h.client.syncOnce();
  await waitFor(async () => (await row()).backup.latestSeq === 1);
  expect((await row()).backupRequested).toBe(false);

  // Delivered once: a later sync does not ask again.
  await h.client.syncOnce();
  expect((await row()).backupRequested).toBe(false);
});

test("a backup request for an unknown client is refused", async () => {
  await expect(
    h.server.owner(
      "/v1/owner/workspace/backup-request",
      { client: "c-00000000-0000-4000-8000-000000000000" },
      stepUp,
    ),
  ).rejects.toThrow("Unknown workspace client");
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met in time");
}
