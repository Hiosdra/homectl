// Owner view of linked clients (homelab #21 §6): mirrored status plus backup
// health. Lag compares what the client last reported with what this server
// holds, so a server that lost history shows the gap rather than hiding it.
import type { BackupStore } from "../backup";
import { status as backupStatus } from "../backup";
import type { ChunkQuota } from "./quota";
import { backupClientId, type ServerState } from "./state";

const STALE_MS = 60_000;

export async function clientRows(
  state: ServerState,
  store: BackupStore,
  quota: ChunkQuota,
  now: number,
) {
  const rows = [];
  for (const [id, client] of Object.entries(state.clients)) {
    const bid = backupClientId(id);
    const held = await backupStatus(store, bid);
    const reported = client.backupReport?.seq ?? null;
    rows.push({
      id,
      name: client.name,
      platform: client.platform,
      joinedAt: client.joinedAt,
      lastSeenAt: client.lastSeenAt ?? null,
      stale:
        client.lastSeenAt === undefined || now - client.lastSeenAt > STALE_MS,
      remoteApproval: client.remoteApproval === true,
      vaultUnlocked: client.vaultUnlocked === true,
      pending: client.pending.length,
      mirror: {
        lastSeq: client.mirror.lastSeq,
        gaps: client.mirror.gaps ?? 0,
      },
      backupRequested: client.backupRequested === true,
      backup: {
        latestSeq: held.latestSeq,
        latestAt: held.latestAt,
        // Kept for the panel's existing fields: count and oldestAt are unchanged.
        count: held.count,
        bytes: held.bytes,
        oldestAt: held.oldestAt,
        clientSeq: reported,
        lagSnapshots:
          reported === null
            ? null
            : Math.max(0, reported - (held.latestSeq ?? 0)),
        lagSeconds:
          held.latestAt === null
            ? null
            : Math.max(0, Math.floor((now - held.latestAt) / 1000)),
        clientLastError: client.backupReport?.lastError ?? null,
        snapshots: held.count,
        storedBytes: held.storedBytes,
        quota: {
          usedBytes: await quota.usage(bid),
          limitBytes: quota.limitBytes,
        },
        // Automatic pruning is not scheduled yet: history is kept until pruned.
        retention: {
          snapshots: held.count,
          oldestAt: held.oldestAt,
          scheduled: false,
        },
      },
    });
  }
  return rows;
}
