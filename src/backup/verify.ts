// Snapshot verification (homelab #21 §6). Decrypts the manifest and every
// chunk the manifest references, checks each chunk id (keyed HMAC of its
// plaintext) and each file's size and sha256, and checks that the cleartext
// header matches the sealed body. verify and restore share this walk so that
// restore can never return data that verification would have rejected.
import { createHash } from "node:crypto";
import {
  assertKey,
  canonicalJson,
  chunkAad,
  chunkId,
  deriveKeys,
  manifestAad,
  open,
  sha256Hex,
} from "./keys";
import type { BackupStore } from "./store";
import type { Manifest, ManifestHeader } from "./types";
import { assertClient, assertSeq, parseManifest } from "./types";

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

export interface RestoredFile {
  path: string;
  data: Uint8Array;
}

export interface Inspection {
  ok: boolean;
  problems: string[];
  manifest?: Manifest;
  files?: RestoredFile[];
}

export async function inspectSnapshot(
  store: BackupStore,
  client: string,
  seq: number,
  key: Uint8Array,
  collect: boolean,
): Promise<Inspection> {
  assertClient(client);
  assertSeq(seq);
  assertKey(key);
  const problems = new Set<string>();
  const stored = await store.manifests.read(client, seq);
  if (!stored) return { ok: false, problems: [`Snapshot ${seq} is missing`] };

  const keys = deriveKeys(key);
  let manifest: Manifest;
  const header: ManifestHeader = stored.header;
  try {
    const plaintext = open(
      keys.manifest,
      new Uint8Array(Buffer.from(stored.sealed, "base64")),
      manifestAad(client, seq),
    );
    if (sha256Hex(plaintext) !== header.manifestHash)
      problems.add("Manifest hash does not match the header");
    const text = Buffer.from(plaintext).toString("utf8");
    manifest = parseManifest(JSON.parse(text));
    if (canonicalJson(manifest) !== text)
      problems.add("Manifest is not in canonical form");
  } catch {
    return {
      ok: false,
      problems: ["Manifest cannot be decrypted (wrong key or tampered data)"],
    };
  }

  if (
    manifest.client !== client ||
    manifest.seq !== seq ||
    manifest.parent !== header.parent ||
    manifest.createdAt !== header.createdAt
  )
    problems.add("Manifest fields do not match the header");

  const referenced = new Set<string>();
  let bytes = 0;
  for (const file of manifest.files) {
    bytes += file.size;
    for (const id of file.chunks) referenced.add(id);
  }
  if (
    referenced.size !== header.chunks.length ||
    header.chunks.some((id) => !referenced.has(id))
  )
    problems.add("Chunk list does not match the header");
  if (bytes !== header.bytes)
    problems.add("Byte total does not match the header");

  if (header.parent !== null) {
    const previous = await store.manifests.read(client, seq - 1);
    if (previous && previous.header.manifestHash !== header.parent)
      problems.add("Parent link does not match the previous manifest");
  }

  const files: RestoredFile[] = [];
  for (const file of manifest.files) {
    const hash = createHash("sha256");
    const parts: Uint8Array[] = [];
    let total = 0;
    let fileOk = true;
    for (const id of file.chunks) {
      const plain = await loadChunk(store, keys.chunk, keys.mac, id, problems);
      if (!plain) {
        fileOk = false;
        continue;
      }
      hash.update(plain);
      total += plain.length;
      if (collect) parts.push(plain);
    }
    if (!fileOk) continue;
    if (total !== file.size) problems.add(`Size mismatch for ${file.path}`);
    if (hash.digest("hex") !== file.sha256)
      problems.add(`sha256 mismatch for ${file.path}`);
    else if (collect && total === file.size)
      files.push({ path: file.path, data: Buffer.concat(parts) });
  }

  const list = [...problems];
  return {
    ok: list.length === 0,
    problems: list,
    manifest,
    files: collect ? files : undefined,
  };
}

async function loadChunk(
  store: BackupStore,
  chunkKey: Uint8Array,
  macKey: Uint8Array,
  id: string,
  problems: Set<string>,
): Promise<Uint8Array | undefined> {
  let blob: Uint8Array;
  try {
    blob = await store.chunks.get(id);
  } catch {
    problems.add(`Chunk ${id.slice(0, 12)} is missing`);
    return undefined;
  }
  let plain: Uint8Array;
  try {
    plain = open(chunkKey, blob, chunkAad(id));
  } catch {
    problems.add(
      `Chunk ${id.slice(0, 12)} fails authentication (tampered or wrong key)`,
    );
    return undefined;
  }
  if (chunkId(macKey, plain) !== id) {
    problems.add(`Chunk ${id.slice(0, 12)} has the wrong id for its content`);
    return undefined;
  }
  return plain;
}

export async function verifySnapshot(
  store: BackupStore,
  client: string,
  seq: number,
  key: Uint8Array,
): Promise<VerifyResult> {
  const inspection = await inspectSnapshot(store, client, seq, key, false);
  return { ok: inspection.ok, problems: inspection.problems };
}
