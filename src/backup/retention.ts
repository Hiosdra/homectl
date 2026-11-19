// Retention and compaction (homelab #21 §6). prune removes old manifests but
// always keeps the newest verified snapshot and everything newer than it, so
// a known-good restore point survives. Chunk garbage collection is mark and
// sweep across every client: a chunk is kept while any remaining manifest of
// any client references it. Chunks younger than graceMs are never swept, so an
// upload still waiting for its commit cannot be collected.
import { withFileLock } from "../control/file-lock";
import { HomectlError } from "../types";
import { assertKey } from "./keys";
import type { BackupStore } from "./store";
import { clientsWithManifests } from "./store";
import type { StoredManifest } from "./types";
import { assertClient } from "./types";
import { verifySnapshot } from "./verify";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  keepMs: number;
  now: number;
  keepLatestVerified: true;
  // With a key, "verified" means full verification (decrypts everything).
  // Without one, it means every referenced chunk is present and the chain
  // link holds. Routine server runs have no key, so they use the structural
  // check.
  key?: Uint8Array;
  graceMs?: number;
}

export interface PruneStats {
  removedManifests: number;
  removedChunks: number;
  bytesFreed: number;
}

export async function prune(
  store: BackupStore,
  client: string,
  options: PruneOptions,
): Promise<PruneStats> {
  assertClient(client);
  if (!Number.isFinite(options.keepMs) || options.keepMs < 0)
    throw new HomectlError(2, "keepMs must be a non-negative number");
  if (options.key) assertKey(options.key);
  await store.ensureRoot();
  return withFileLock(store.lockPath(), "backup store", async () => {
    const history = await store.manifests.list(client);
    const keepFrom = await newestVerifiedSeq(store, client, history, options);
    let removedManifests = 0;
    let bytesFreed = 0;
    // No verified snapshot means nothing is pruned: fail safe.
    if (keepFrom !== undefined) {
      const cutoff = options.now - options.keepMs;
      for (const item of history) {
        if (item.header.seq >= keepFrom || item.header.createdAt >= cutoff)
          continue;
        bytesFreed += await store.manifests.remove(client, item.header.seq);
        removedManifests += 1;
      }
    }
    const swept = await collectGarbage(store, {
      now: options.now,
      graceMs: options.graceMs ?? DAY_MS,
    });
    return {
      removedManifests,
      removedChunks: swept.removedChunks,
      bytesFreed: bytesFreed + swept.bytesFreed,
    };
  });
}

async function newestVerifiedSeq(
  store: BackupStore,
  client: string,
  history: StoredManifest[],
  options: PruneOptions,
): Promise<number | undefined> {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item) continue;
    if (await isVerified(store, client, item, options.key))
      return item.header.seq;
  }
  return undefined;
}

async function isVerified(
  store: BackupStore,
  client: string,
  item: StoredManifest,
  key: Uint8Array | undefined,
): Promise<boolean> {
  if (key)
    return (await verifySnapshot(store, client, item.header.seq, key)).ok;
  for (const id of item.header.chunks)
    if (!(await store.chunks.has(id))) return false;
  return true;
}

export interface GarbageStats {
  removedChunks: number;
  bytesFreed: number;
}

// Removes chunks that no remaining manifest of any client references and that
// are older than graceMs. If any manifest cannot be read, this throws and
// nothing is removed: an unreadable manifest could hide live references.
export async function collectGarbage(
  store: BackupStore,
  options: { now: number; graceMs: number },
): Promise<GarbageStats> {
  const referenced = new Set<string>();
  for (const client of await clientsWithManifests(store))
    for (const item of await store.manifests.list(client))
      for (const id of item.header.chunks) referenced.add(id);

  let removedChunks = 0;
  let bytesFreed = 0;
  for (const id of await store.chunks.list()) {
    if (referenced.has(id)) continue;
    const info = await store.chunks.stat(id);
    if (info.mtimeMs > options.now - options.graceMs) continue;
    bytesFreed += await store.chunks.remove(id);
    removedChunks += 1;
  }
  return { removedChunks, bytesFreed };
}
