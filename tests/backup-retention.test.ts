import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "../src/backup";
import {
  buildSnapshot,
  LocalBackupServer,
  newClientKey,
  prune,
  status,
  uploadSnapshot,
  verifySnapshot,
} from "../src/backup";
import type { Fixture } from "./backup-helpers";
import { bytesOf, CLIENT, fixture, SMALL_CHUNK } from "./backup-helpers";

const DAY = 24 * 60 * 60 * 1000;
const key = newClientKey();
const base = Date.now();
const now = base + 2 * DAY;

let current: Fixture | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

function activeStore(): Fixture["store"] {
  if (!current) throw new Error("fixture missing");
  return current.store;
}

function snap(
  seq: number,
  parent: string | null,
  createdAt: number,
  files: { path: string; data: Uint8Array }[],
  client = CLIENT,
  clientKey = key,
): Snapshot {
  return buildSnapshot(files, {
    client,
    key: clientKey,
    seq,
    parent,
    now: createdAt,
    chunkSize: SMALL_CHUNK,
  });
}

// Four snapshots, oldest first. s3 shares one chunk with s1. s4 (the newest)
// has one chunk deleted, so it is not verified and s3 is the newest verified.
async function scenario(): Promise<Snapshot[]> {
  const fx = await fixture();
  current = fx;
  const { server, store } = fx;
  const s1Data = bytesOf(32, 21);
  const s1 = snap(1, null, base - 10 * DAY, [
    { path: "state/a.db", data: s1Data },
  ]);
  const s2 = snap(2, s1.header.manifestHash, base - 9 * DAY, [
    { path: "state/a.db", data: bytesOf(32, 22) },
  ]);
  const shared = new Uint8Array([
    ...s1Data.subarray(0, 16),
    ...bytesOf(16, 23),
  ]);
  const s3 = snap(3, s2.header.manifestHash, base - 8 * DAY, [
    { path: "state/a.db", data: shared },
  ]);
  const s4 = snap(4, s3.header.manifestHash, base - 1 * DAY, [
    { path: "state/a.db", data: bytesOf(32, 24) },
  ]);
  for (const item of [s1, s2, s3, s4]) await uploadSnapshot(server, item);
  const missing = s4.header.chunks[0] ?? "";
  await rm(join(store.root, "chunks", missing.slice(0, 2), missing));
  return [s1, s2, s3, s4];
}

describe("backup retention and garbage collection", () => {
  test("prune keeps the newest verified snapshot and all newer ones", async () => {
    const snapshots = await scenario();
    const store = activeStore();
    expect((await status(store, CLIENT)).count).toBe(4);

    const stats = await prune(store, CLIENT, {
      keepMs: 5 * DAY,
      now,
      keepLatestVerified: true,
    });
    expect(stats.removedManifests).toBe(2);
    // Exclusive chunks of s1 (1) and s2 (2) are swept; s3's shared chunk stays.
    expect(stats.removedChunks).toBe(3);
    expect(stats.bytesFreed).toBeGreaterThan(0);

    const after = await status(store, CLIENT);
    expect(after.count).toBe(2);
    expect(after.latestSeq).toBe(4);
    expect(after.oldestAt).toBe(base - 8 * DAY);
    expect(after.bytes).toBe(
      (snapshots[2]?.header.bytes ?? 0) + (snapshots[3]?.header.bytes ?? 0),
    );
    expect((await verifySnapshot(store, CLIENT, 3, key)).ok).toBe(true);
  });

  test("GC keeps every chunk referenced by a retained snapshot", async () => {
    const snapshots = await scenario();
    const store = activeStore();
    await prune(store, CLIENT, {
      keepMs: 5 * DAY,
      now,
      keepLatestVerified: true,
    });
    for (const id of snapshots[2]?.header.chunks ?? [])
      expect(await store.chunks.has(id)).toBe(true);
  });

  test("with a key, prune uses full verification and reaches the same result", async () => {
    await scenario();
    const stats = await prune(activeStore(), CLIENT, {
      keepMs: 5 * DAY,
      now,
      keepLatestVerified: true,
      key,
    });
    expect(stats.removedManifests).toBe(2);
  });

  test("prune removes nothing when no snapshot verifies", async () => {
    const fx = await fixture();
    current = fx;
    const only = snap(1, null, base - 10 * DAY, [
      { path: "state/a.db", data: bytesOf(32, 31) },
    ]);
    await uploadSnapshot(fx.server, only);
    const id = only.header.chunks[0] ?? "";
    await rm(join(fx.store.root, "chunks", id.slice(0, 2), id));

    const stats = await prune(fx.store, CLIENT, {
      keepMs: 5 * DAY,
      now,
      keepLatestVerified: true,
    });
    expect(stats.removedManifests).toBe(0);
    expect((await status(fx.store, CLIENT)).count).toBe(1);
  });

  test("GC never removes chunks another client still references", async () => {
    await scenario();
    const store = activeStore();
    const other = snap(
      1,
      null,
      base - 100 * DAY,
      [{ path: "state/t.db", data: bytesOf(32, 41) }],
      "tablet-b",
      newClientKey(),
    );
    await uploadSnapshot(new LocalBackupServer(store), other);

    await prune(store, CLIENT, {
      keepMs: 5 * DAY,
      now,
      keepLatestVerified: true,
    });
    for (const id of other.header.chunks)
      expect(await store.chunks.has(id)).toBe(true);
    expect((await status(store, "tablet-b")).count).toBe(1);
  });

  test("the grace period protects chunks that are not yet committed", async () => {
    await scenario();
    const stats = await prune(activeStore(), CLIENT, {
      keepMs: 5 * DAY,
      now: base,
      keepLatestVerified: true,
      graceMs: 3 * DAY,
    });
    expect(stats.removedChunks).toBe(0);
  });

  test("status reports latest, count, bytes and oldest for the panel", async () => {
    await scenario();
    const info = await status(activeStore(), CLIENT);
    expect(info.latestSeq).toBe(4);
    expect(info.count).toBe(4);
    expect(info.latestAt).toBe(base - 1 * DAY);
    expect(info.oldestAt).toBe(base - 10 * DAY);
    expect(info.bytes).toBe(4 * 32);
  });

  test("an empty client reports no history", async () => {
    const fx = await fixture();
    current = fx;
    expect(await status(fx.store, "nobody")).toEqual({
      latestSeq: null,
      latestAt: null,
      count: 0,
      bytes: 0,
      storedBytes: 0,
      oldestAt: null,
    });
  });
});
