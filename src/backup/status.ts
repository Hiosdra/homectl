// Backup status for the panel (homelab #21 §6). Reads only manifest headers,
// so it never needs a key.
import type { BackupStore } from "./store";
import { assertClient } from "./types";

export interface BackupStatus {
  latestSeq: number | null;
  latestAt: number | null;
  count: number; // retained snapshots
  bytes: number; // logical plaintext bytes summed over retained snapshots
  storedBytes: number; // sealed bytes of the distinct chunks they reference
  oldestAt: number | null;
}

export async function status(
  store: BackupStore,
  client: string,
): Promise<BackupStatus> {
  assertClient(client);
  const items = (await store.manifests.list(client)).map((item) => item.header);
  const latest = items.at(-1);
  const oldest = items[0];
  const distinct = new Set(items.flatMap((item) => item.chunks));
  let storedBytes = 0;
  for (const id of distinct)
    storedBytes +=
      (await store.chunks.stat(id).catch(() => undefined))?.size ?? 0;
  return {
    latestSeq: latest?.seq ?? null,
    latestAt: latest?.createdAt ?? null,
    count: items.length,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    storedBytes,
    oldestAt: oldest?.createdAt ?? null,
  };
}
