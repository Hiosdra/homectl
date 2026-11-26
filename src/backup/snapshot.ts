// Client-side snapshot construction (homelab #21 §6). Pure: no I/O. Splits
// each file into fixed-size chunks, seals every chunk under the client key,
// and produces the sealed manifest plus its cleartext header.
import { HomectlError } from "../types";
import {
  assertKey,
  canonicalJson,
  chunkAad,
  chunkId,
  deriveKeys,
  manifestAad,
  seal,
  sha256Hex,
} from "./keys";
import { assertNotExcluded, assertSafePath } from "./policy";
import type { Manifest, ManifestFile, ManifestHeader } from "./types";
import {
  assertClient,
  assertParent,
  assertSeq,
  SNAPSHOT_VERSION,
} from "./types";

// Fixed chunk size. Tests override it through SnapshotContext.chunkSize.
export const CHUNK_SIZE = 1024 * 1024;

export interface SnapshotInput {
  path: string;
  data: Uint8Array;
}

export interface SnapshotContext {
  client: string;
  key: Uint8Array; // the client's 32-byte backup key
  seq: number;
  parent: string | null; // manifest hash of the previous snapshot, or null
  now: number;
  chunkSize?: number;
}

export interface Snapshot {
  manifest: Manifest;
  header: ManifestHeader;
  sealed: string; // base64 sealed manifest
  chunks: Map<string, Uint8Array>; // chunk id -> sealed blob
}

export function buildSnapshot(
  files: readonly SnapshotInput[],
  ctx: SnapshotContext,
): Snapshot {
  assertClient(ctx.client);
  assertSeq(ctx.seq);
  assertParent(ctx.parent);
  assertKey(ctx.key);
  const size = ctx.chunkSize ?? CHUNK_SIZE;
  if (!Number.isSafeInteger(size) || size < 1)
    throw new HomectlError(2, "Chunk size must be a positive integer");

  const keys = deriveKeys(ctx.key);
  const chunks = new Map<string, Uint8Array>();
  const entries: ManifestFile[] = [];
  const paths = new Set<string>();
  const referenced = new Set<string>();
  let bytes = 0;

  for (const file of files) {
    assertSafePath(file.path);
    assertNotExcluded(file.path);
    if (paths.has(file.path))
      throw new HomectlError(2, `Duplicate backup path: ${file.path}`);
    paths.add(file.path);

    const ids: string[] = [];
    for (let offset = 0; offset < file.data.length; offset += size) {
      const plain = file.data.subarray(offset, offset + size);
      const id = chunkId(keys.mac, plain);
      ids.push(id);
      referenced.add(id);
      if (!chunks.has(id))
        chunks.set(id, seal(keys.chunk, plain, chunkAad(id)));
    }
    bytes += file.data.length;
    entries.push({
      path: file.path,
      size: file.data.length,
      sha256: sha256Hex(file.data),
      chunks: ids,
    });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: Manifest = {
    v: SNAPSHOT_VERSION,
    client: ctx.client,
    seq: ctx.seq,
    parent: ctx.parent,
    createdAt: ctx.now,
    files: entries,
  };
  const plaintext = new TextEncoder().encode(canonicalJson(manifest));
  const header: ManifestHeader = {
    v: SNAPSHOT_VERSION,
    client: ctx.client,
    seq: ctx.seq,
    parent: ctx.parent,
    manifestHash: sha256Hex(plaintext),
    createdAt: ctx.now,
    chunks: [...referenced].sort(),
    bytes,
  };
  const sealed = seal(
    keys.manifest,
    plaintext,
    manifestAad(ctx.client, ctx.seq),
  );
  return {
    manifest,
    header,
    sealed: Buffer.from(sealed).toString("base64"),
    chunks,
  };
}
