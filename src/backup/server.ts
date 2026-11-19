// Server-side commit protocol (homelab #21 §6). The server verifies what it
// can without the client key: the chain (seq and parent), the presence of
// every referenced chunk, and that the sealed blob is well formed. It never
// decrypts. Content integrity is checked by verifySnapshot.
import { withFileLock } from "../control/file-lock";
import { HomectlError } from "../types";
import { BLOB_VERSION } from "./keys";
import type { BackupStore } from "./store";
import type { ManifestHeader, StoredManifest } from "./types";
import { assertChunkId, assertSeq, parseHeader } from "./types";

export interface CommitRequest {
  header: ManifestHeader;
  sealed: string;
}

export type CommitResult =
  | { status: "committed"; seq: number }
  | { status: "unchanged"; seq: number }
  // The client's parent is unknown here: send a full baseline (parent null).
  | { status: "gap"; latestSeq: number; latestHash: string | null };

// The only operations a client uses. Transport-agnostic: a local store, an
// HTTPS client, or a test double can implement it.
export interface BackupServer {
  missing(ids: readonly string[]): Promise<string[]>;
  putChunk(id: string, blob: Uint8Array): Promise<void>;
  commit(request: CommitRequest): Promise<CommitResult>;
}

export class LocalBackupServer implements BackupServer {
  constructor(readonly store: BackupStore) {}

  async missing(ids: readonly string[]): Promise<string[]> {
    const absent: string[] = [];
    for (const id of ids) {
      assertChunkId(id);
      if (!(await this.store.chunks.has(id))) absent.push(id);
    }
    return absent;
  }

  async putChunk(id: string, blob: Uint8Array): Promise<void> {
    await this.store.chunks.put(id, blob);
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    const header = parseHeader(request.header);
    assertSeq(header.seq);
    assertSealed(request.sealed);
    await this.store.ensureRoot();
    return withFileLock(this.store.lockPath(), "backup store", () =>
      this.commitLocked(header, request.sealed),
    );
  }

  private async commitLocked(
    header: ManifestHeader,
    sealed: string,
  ): Promise<CommitResult> {
    const history = await this.store.manifests.list(header.client);
    const latest = history.at(-1);
    const latestSeq = latest?.header.seq ?? 0;
    const latestHash = latest?.header.manifestHash ?? null;

    // 1. Idempotent retry: the same manifest is already retained at this seq.
    const existing = history.find((item) => item.header.seq === header.seq);
    if (existing?.header.manifestHash === header.manifestHash)
      return { status: "unchanged", seq: header.seq };

    // 2. A parent this server does not know: the client must send a baseline.
    //    Checked before seq, so a client reinstalled at an old seq gets a gap.
    if (
      header.parent !== null &&
      !history.some((item) => item.header.manifestHash === header.parent)
    )
      return { status: "gap", latestSeq, latestHash };

    // 3. Another manifest already holds this seq.
    if (header.seq <= latestSeq)
      throw new HomectlError(
        2,
        `Conflicting manifest at seq ${header.seq}: the server already holds a different one`,
      );

    if (header.seq !== latestSeq + 1)
      throw new HomectlError(
        2,
        `Expected seq ${latestSeq + 1}, got ${header.seq}`,
      );
    if (header.parent !== null && header.parent !== latestHash)
      throw new HomectlError(
        2,
        "Bad parent: it is not the latest manifest of this chain",
      );

    for (const id of header.chunks)
      if (!(await this.store.chunks.has(id)))
        throw new HomectlError(
          2,
          `Commit rejected: chunk ${id.slice(0, 12)} is not uploaded`,
        );

    const stored: StoredManifest = { header, sealed };
    await this.store.manifests.write(header.client, stored);
    return { status: "committed", seq: header.seq };
  }
}

function assertSealed(sealed: string): void {
  if (typeof sealed !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed))
    throw new HomectlError(2, "Sealed manifest must be base64");
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < 29 || bytes[0] !== BLOB_VERSION)
    throw new HomectlError(2, "Sealed manifest is not a backup blob");
}
