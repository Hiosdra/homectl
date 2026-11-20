// Per-client storage quota for uploaded backup chunks (homelab #21 §6). The
// server counts the sealed bytes of distinct chunks each client holds: chunks
// referenced by its retained snapshots, plus chunks uploaded since the ledger
// was built. The ledger is built from the manifests at startup and rebuilt
// after any removal from the store (a prune or a sweep), so a pruned client is
// not overcounted until restart. Chunks already held are never charged twice.
import type { BackupStore } from "../backup";
import { storeRevision } from "../backup/store";
import { HomectlError } from "../types";

export const DEFAULT_CLIENT_QUOTA_BYTES = 1024 * 1024 * 1024;

interface Ledger {
  chunks: Map<string, number>;
  bytes: number;
}

export interface Reservation {
  // Gives the bytes back when the chunk write failed.
  release(): void;
}

const HELD: Reservation = { release() {} };

export class ChunkQuota {
  private readonly ledgers = new Map<
    string,
    { revision: number; load: Promise<Ledger> }
  >();

  constructor(
    private readonly store: BackupStore,
    readonly limitBytes: number = DEFAULT_CLIENT_QUOTA_BYTES,
  ) {}

  // bid is the backup client id (c-<link id>).
  async usage(bid: string): Promise<number> {
    return (await this.ledger(bid)).bytes;
  }

  // Charges one chunk before it is written. The check and the charge happen
  // in one synchronous step after the ledger is loaded, so concurrent uploads
  // cannot overshoot the limit together.
  async reserve(bid: string, id: string, bytes: number): Promise<Reservation> {
    const ledger = await this.ledger(bid);
    if (ledger.chunks.has(id)) return HELD;
    if (ledger.bytes + bytes > this.limitBytes)
      throw new HomectlError(
        3,
        `Backup storage quota reached: this client holds ${ledger.bytes} of ${this.limitBytes} bytes and this chunk needs ${bytes} more. Remove old backups or raise HOMECTL_WORKSPACE_QUOTA_MB.`,
      );
    ledger.chunks.set(id, bytes);
    ledger.bytes += bytes;
    return {
      release: () => {
        if (ledger.chunks.get(id) !== bytes) return;
        ledger.chunks.delete(id);
        ledger.bytes -= bytes;
      },
    };
  }

  // Reuses the cached ledger while the store has not removed anything since it
  // was built; otherwise rebuilds it from the manifests.
  private ledger(bid: string): Promise<Ledger> {
    const revision = storeRevision(this.store.root);
    const cached = this.ledgers.get(bid);
    if (cached && cached.revision === revision) return cached.load;
    const load = this.load(bid);
    this.ledgers.set(bid, { revision, load });
    // A failed load is retried by the next call.
    load.catch(() => {
      if (this.ledgers.get(bid)?.load === load) this.ledgers.delete(bid);
    });
    return load;
  }

  private async load(bid: string): Promise<Ledger> {
    const ledger: Ledger = { chunks: new Map(), bytes: 0 };
    for (const stored of await this.store.manifests.list(bid))
      for (const id of stored.header.chunks) {
        if (ledger.chunks.has(id)) continue;
        const info = await this.store.chunks.stat(id).catch(() => undefined);
        if (!info) continue;
        ledger.chunks.set(id, info.size);
        ledger.bytes += info.size;
      }
    return ledger;
  }
}
