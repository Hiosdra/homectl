// Incremental encrypted backups (0.3.0, homelab #21 §6).

export type { ClientKeys, KeyPurpose } from "./keys";
export {
  BLOB_VERSION,
  canonicalJson,
  chunkId,
  deriveKeys,
  keyFor,
  newClientKey,
  open,
  seal,
  unwrapKey,
  wrapKey,
} from "./keys";
export { assertNotExcluded, assertSafePath, EXCLUDE_PATTERNS } from "./policy";
export type { RestoreAuthorization } from "./restore";
export {
  assertRestoreAuthorization,
  restoreSnapshot,
  unwrapCustodyKey,
} from "./restore";
export type { PruneOptions, PruneStats } from "./retention";
export { collectGarbage, prune } from "./retention";
export type { BackupServer, CommitRequest, CommitResult } from "./server";
export { LocalBackupServer } from "./server";
export type { Snapshot, SnapshotContext, SnapshotInput } from "./snapshot";
export { buildSnapshot, CHUNK_SIZE } from "./snapshot";
export type { BackupStatus } from "./status";
export { status } from "./status";
export { BackupStore, ChunkStore, ManifestStore } from "./store";
export type {
  Manifest,
  ManifestFile,
  ManifestHeader,
  StoredManifest,
} from "./types";
export type { BackupOutcome, UploadResult } from "./upload";
export { backup, uploadSnapshot } from "./upload";
export type { RestoredFile, VerifyResult } from "./verify";
export { inspectSnapshot, verifySnapshot } from "./verify";
