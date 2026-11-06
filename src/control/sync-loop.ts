// Continuous control-plane sync (ADR-0002 decision 4). Each round publishes this
// device's records, then pulls every paired peer that is due. A failing peer is
// retried with exponential backoff; the last successful sync per peer is the
// lease evidence used by the fence. The transport is injected: in the running
// app it is the authenticated peer channel; in tests it is in-process.

import { backoffMs } from "./lease";
import type { ControlReplicator, Pull } from "./replicator";

export const SYNC_INTERVAL_MS = 15_000;

export interface PeerSyncStatus {
  id: string;
  name: string;
  lastSync?: number;
  lastError?: string;
  failures: number;
  nextAttemptAt: number;
  refused?: string;
}

export type Transport = (
  peerId: string,
  request: { known: Record<string, { seq: number; hash: string }> },
) => Promise<Parameters<ControlReplicator["receive"]>[0]>;

export class SyncLoop {
  private state: Record<
    string,
    Omit<PeerSyncStatus, "id" | "name" | "refused">
  > = {};

  constructor(
    private readonly rep: ControlReplicator,
    private readonly transport: Transport,
    private readonly clock: () => number = Date.now,
    private readonly intervalMs = SYNC_INTERVAL_MS,
  ) {}

  // One round over every due peer. Returns what each attempted peer delivered.
  // `force` ignores the per-peer interval and backoff: used for manual rounds.
  async tick(
    options: { force?: boolean } = {},
  ): Promise<Record<string, Pull | { error: string } | "refused">> {
    await this.rep.publish();
    const results: Record<string, Pull | { error: string } | "refused"> = {};
    for (const id of this.rep.peerIds()) {
      const refused = this.rep.refusalFor(id);
      const current = this.state[id] ?? { failures: 0, nextAttemptAt: 0 };
      this.state[id] = current;
      if (refused) {
        results[id] = "refused";
        continue;
      }
      if (!options.force && this.clock() < current.nextAttemptAt) continue;
      try {
        const response = await this.transport(id, this.rep.request());
        const pull = await this.rep.receive(response, id);
        this.state[id] = {
          failures: 0,
          lastSync: this.clock(),
          nextAttemptAt: this.clock() + this.intervalMs,
        };
        results[id] = pull;
      } catch (error) {
        const failures = current.failures + 1;
        this.state[id] = {
          failures,
          lastError: error instanceof Error ? error.message : "sync failed",
          lastSync: current.lastSync,
          nextAttemptAt: this.clock() + backoffMs(failures),
        };
        results[id] = { error: this.state[id]?.lastError ?? "sync failed" };
      }
    }
    return results;
  }

  // Last-sync status per paired peer, for the CLI and the Sync view.
  statuses(): PeerSyncStatus[] {
    return this.rep.peerIds().map((id) => {
      const refused = this.rep.refusalFor(id);
      const s = this.state[id] ?? { failures: 0, nextAttemptAt: 0 };
      return {
        id,
        name: this.rep.nameOfPeer(id),
        lastSync: s.lastSync,
        lastError: s.lastError,
        failures: s.failures,
        nextAttemptAt: s.nextAttemptAt,
        ...(refused ? { refused } : {}),
      };
    });
  }
}
