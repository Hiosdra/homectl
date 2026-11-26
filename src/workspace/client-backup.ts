// Client backup runner extracted from WorkspaceClient so each module stays
// focused and under the file-length limit.
import { type BackupServer, backup, type SnapshotInput } from "../backup";
import { isExcluded } from "../backup/policy";
import { channelRequest, type Post } from "./channel";
import { backupClientId, type ClientLink, type ClientLinkFile } from "./state";
import { errorText, peerOf } from "./summary";
import * as v from "./validate";

export interface BackupRun {
  seq: number;
  uploaded: number;
  reused: number;
  baseline: boolean;
}

export async function runClientBackup(deps: {
  link: ClientLink;
  file: ClientLinkFile;
  post: (address: string) => Post;
  backupFiles: () => Promise<SnapshotInput[]>;
  registerBackupKey: () => Promise<void>;
  now: () => number;
}): Promise<BackupRun | undefined> {
  const { link, file } = deps;
  const server = link.server;
  if (!server) return undefined;
  try {
    if (!link.backupKeyRegistered) await deps.registerBackupKey();
    const files = (await deps.backupFiles()).filter(
      (entry) => !isExcluded(entry.path),
    );
    const transport = deps.post(server.address);
    const peer = peerOf(server);
    const call = (action: string, payload: unknown) =>
      channelRequest(transport, link.id, peer, action, payload);
    const adapter: BackupServer = {
      missing: async (ids) =>
        v.list(
          await call("backup.missing", { ids: [...ids] }),
          "missing ids",
          v.MAX_MISSING_IDS,
          (id) => v.hex(id, "chunk id"),
        ),
      putChunk: async (id, blob) => {
        await call("backup.chunk", {
          id,
          blob: Buffer.from(blob).toString("base64"),
        });
      },
      commit: async (request) =>
        v.parseCommit(
          await call("backup.commit", {
            header: request.header,
            sealed: request.sealed,
          }),
        ),
    };
    const outcome = await backup(adapter, files, {
      client: backupClientId(link.id),
      key: Buffer.from(link.backup.key, "hex"),
      seq: link.backup.seq + 1,
      parent: link.backup.parent,
      now: deps.now(),
    });
    const header = outcome.snapshot.header;
    const at = deps.now();
    await file.update((next) => {
      if (!next.server) return;
      next.backup = {
        ...next.backup,
        seq: header.seq,
        parent: header.manifestHash,
        lastAt: at,
        lastError: undefined,
      };
    });
    return {
      seq: header.seq,
      uploaded: outcome.uploaded,
      reused: outcome.reused,
      baseline: outcome.baseline,
    };
  } catch (error) {
    await file.update((next) => {
      next.backup = { ...next.backup, lastError: errorText(error) };
    });
    throw error;
  }
}
