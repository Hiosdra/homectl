// Client upload protocol (homelab #21 §6), transport-agnostic.
//   1. server.missing(ids): upload only chunks the server does not hold.
//   2. server.putChunk for each missing blob.
//   3. server.commit(header, sealed).
// Any subset of step 2 may have landed before an interruption; re-running
// asks again and uploads only what is still missing. A history gap is answered
// with a full baseline (parent null) that starts a new chain and keeps the old
// history on the server.
import { HomectlError } from "../types";
import type { BackupServer, CommitResult } from "./server";
import type { Snapshot, SnapshotContext, SnapshotInput } from "./snapshot";
import { buildSnapshot } from "./snapshot";

export interface UploadResult {
  result: CommitResult;
  uploaded: number; // chunk blobs sent in this run
  reused: number; // chunk blobs the server already held
}

export async function uploadSnapshot(
  server: BackupServer,
  snapshot: Snapshot,
): Promise<UploadResult> {
  const ids = [...snapshot.chunks.keys()];
  const missing = await server.missing(ids);
  for (const id of missing) {
    const blob = snapshot.chunks.get(id);
    if (!blob)
      throw new HomectlError(
        2,
        "Server asked for a chunk outside the snapshot",
      );
    await server.putChunk(id, blob);
  }
  const result = await server.commit({
    header: snapshot.header,
    sealed: snapshot.sealed,
  });
  return {
    result,
    uploaded: missing.length,
    reused: ids.length - missing.length,
  };
}

export interface BackupOutcome extends UploadResult {
  snapshot: Snapshot;
  baseline: boolean; // true when the server reported a history gap
}

// Builds and uploads one snapshot. On a gap it rebuilds the snapshot as a new
// baseline at latestSeq + 1 and uploads that instead.
export async function backup(
  server: BackupServer,
  files: readonly SnapshotInput[],
  ctx: SnapshotContext,
): Promise<BackupOutcome> {
  const first = buildSnapshot(files, ctx);
  const sent = await uploadSnapshot(server, first);
  if (sent.result.status !== "gap")
    return { ...sent, snapshot: first, baseline: false };

  const baseline = buildSnapshot(files, {
    ...ctx,
    seq: sent.result.latestSeq + 1,
    parent: null,
  });
  const retried = await uploadSnapshot(server, baseline);
  if (retried.result.status === "gap")
    throw new HomectlError(5, "Baseline was still reported as a history gap");
  return { ...retried, snapshot: baseline, baseline: true };
}
