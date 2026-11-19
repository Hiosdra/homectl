// Backup data shapes and their validators. Everything that crosses the
// client/server boundary is parsed through these guards; nothing is trusted
// because it came from disk or from a peer.
import { CLIENT_ID_PATTERN } from "../core/contracts";
import { HomectlError } from "../types";
import { assertSafePath } from "./policy";

export const SNAPSHOT_VERSION = 1 as const;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  chunks: string[];
}

// Plaintext manifest. Only ever stored sealed (see keys.ts seal/manifestAad).
export interface Manifest {
  v: typeof SNAPSHOT_VERSION;
  client: string;
  seq: number;
  parent: string | null;
  createdAt: number;
  files: ManifestFile[];
}

// Cleartext metadata the server needs to check the chain and chunk presence
// without holding the client key. verifySnapshot checks it against the body.
export interface ManifestHeader {
  v: typeof SNAPSHOT_VERSION;
  client: string;
  seq: number;
  parent: string | null;
  manifestHash: string;
  createdAt: number;
  chunks: string[];
  bytes: number;
}

// On disk and on the wire: manifests/<client>/<seq>.json.enc holds this JSON.
export interface StoredManifest {
  header: ManifestHeader;
  sealed: string; // base64 of the sealed manifest blob
}

export function fail(message: string): never {
  throw new HomectlError(2, message);
}

export function assertClient(client: string): void {
  if (typeof client !== "string" || !CLIENT_ID_PATTERN.test(client))
    fail("Invalid client id for backup");
}

export function assertChunkId(id: string): void {
  if (typeof id !== "string" || !HEX64.test(id)) fail("Invalid chunk id");
}

export function assertSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 1)
    fail("Snapshot seq must be an integer >= 1");
}

export function assertParent(parent: string | null): void {
  if (parent !== null && (typeof parent !== "string" || !HEX64.test(parent)))
    fail("Snapshot parent must be null or a manifest hash");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`${label} must be a non-negative integer`);
  return value;
}

function hex64(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX64.test(value))
    fail(`${label} must be a 64-character hex hash`);
  return value;
}

function hashList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((item) => hex64(item, `${label} entry`));
}

function parentValue(value: unknown): string | null {
  if (value === null) return null;
  return hex64(value, "parent");
}

function clientValue(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_ID_PATTERN.test(value))
    fail("Invalid client id in backup data");
  return value;
}

function versionValue(value: unknown): typeof SNAPSHOT_VERSION {
  if (value !== SNAPSHOT_VERSION) fail("Unsupported backup version");
  return SNAPSHOT_VERSION;
}

export function parseHeader(value: unknown): ManifestHeader {
  const r = record(value, "Manifest header");
  return {
    v: versionValue(r.v),
    client: clientValue(r.client),
    seq: nonNegativeInt(r.seq, "seq"),
    parent: parentValue(r.parent),
    manifestHash: hex64(r.manifestHash, "manifestHash"),
    createdAt: nonNegativeInt(r.createdAt, "createdAt"),
    chunks: hashList(r.chunks, "chunks"),
    bytes: nonNegativeInt(r.bytes, "bytes"),
  };
}

export function parseManifest(value: unknown): Manifest {
  const r = record(value, "Manifest");
  if (!Array.isArray(r.files)) fail("Manifest files must be an array");
  return {
    v: versionValue(r.v),
    client: clientValue(r.client),
    seq: nonNegativeInt(r.seq, "seq"),
    parent: parentValue(r.parent),
    createdAt: nonNegativeInt(r.createdAt, "createdAt"),
    files: r.files.map((entry) => {
      const f = record(entry, "Manifest file");
      if (typeof f.path !== "string")
        fail("Manifest file path must be a string");
      assertSafePath(f.path);
      return {
        path: f.path,
        size: nonNegativeInt(f.size, "size"),
        sha256: hex64(f.sha256, "sha256"),
        chunks: hashList(f.chunks, "file chunks"),
      };
    }),
  };
}

export function parseStored(value: unknown): StoredManifest {
  const r = record(value, "Stored manifest");
  if (typeof r.sealed !== "string" || r.sealed.length === 0)
    fail("Stored manifest has no sealed body");
  return { header: parseHeader(r.header), sealed: r.sealed };
}
