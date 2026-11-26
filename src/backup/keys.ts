// Backup cryptography (0.3.0, homelab #21 §6). Built only on node:crypto:
// HKDF-SHA256 for purpose keys, HMAC-SHA256 for keyed chunk ids, AES-256-GCM
// with a random 12-byte IV for every sealed blob.
//
// Blob layout (chunks, manifests, wrapped keys): version byte | iv | tag |
// ciphertext. The AAD binds a blob to its place (chunk id, manifest seq,
// client id), so a blob cannot be moved to another slot and still open.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { HomectlError } from "../types";

export const KEY_BYTES = 32;
export const BLOB_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const HKDF_SALT = Buffer.from("homectl-backup/v1", "utf8");

export type KeyPurpose = "chunk-enc" | "chunk-id" | "manifest";
const KEY_INFO: Record<KeyPurpose, string> = {
  "chunk-enc": "homectl-backup/v1 chunk encryption",
  "chunk-id": "homectl-backup/v1 chunk id mac",
  manifest: "homectl-backup/v1 manifest encryption",
};

export function newClientKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

export function assertKey(key: Uint8Array, label = "Backup key"): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES)
    throw new HomectlError(2, `${label} must be ${KEY_BYTES} bytes`);
}

// Derives one purpose key from a client backup key. Purpose keys are
// independent, so leaking the MAC key never reveals the encryption key.
export function keyFor(clientKey: Uint8Array, purpose: KeyPurpose): Uint8Array {
  assertKey(clientKey);
  return new Uint8Array(
    hkdfSync("sha256", clientKey, HKDF_SALT, KEY_INFO[purpose], KEY_BYTES),
  );
}

export interface ClientKeys {
  chunk: Uint8Array;
  mac: Uint8Array;
  manifest: Uint8Array;
}

export function deriveKeys(clientKey: Uint8Array): ClientKeys {
  return {
    chunk: keyFor(clientKey, "chunk-enc"),
    mac: keyFor(clientKey, "chunk-id"),
    manifest: keyFor(clientKey, "manifest"),
  };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// Keyed chunk id: hex HMAC-SHA256 of the plaintext, so ids cannot be matched
// against known content by someone without the client's MAC key.
export function chunkId(macKey: Uint8Array, plaintext: Uint8Array): string {
  return createHmac("sha256", macKey).update(plaintext).digest("hex");
}

export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([BLOB_VERSION]),
    iv,
    cipher.getAuthTag(),
    body,
  ]);
}

// Throws HomectlError(5) for wrong key, wrong AAD, unknown version or any
// tampering. The message never distinguishes these cases on purpose.
export function open(
  key: Uint8Array,
  blob: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  assertKey(key);
  if (blob.length < HEADER_BYTES || blob[0] !== BLOB_VERSION)
    throw new HomectlError(5, "Unsupported or truncated backup blob");
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, HEADER_BYTES);
  const body = blob.subarray(HEADER_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new HomectlError(
      5,
      "Backup decryption failed: wrong key, wrong context or tampered data",
    );
  }
}

// Wraps a client backup key under the server custody key (D6A). AAD is the
// client id, so a wrapped key cannot be presented for another client.
export function wrapKey(
  clientKey: Uint8Array,
  custodyKey: Uint8Array,
  clientId: string,
): string {
  assertKey(clientKey, "Client key");
  assertKey(custodyKey, "Custody key");
  return Buffer.from(
    seal(custodyKey, clientKey, Buffer.from(clientId, "utf8")),
  ).toString("base64");
}

export function unwrapKey(
  wrapped: string,
  custodyKey: Uint8Array,
  clientId: string,
): Uint8Array {
  assertKey(custodyKey, "Custody key");
  const blob = new Uint8Array(Buffer.from(wrapped, "base64"));
  const key = open(custodyKey, blob, Buffer.from(clientId, "utf8"));
  if (key.length !== KEY_BYTES)
    throw new HomectlError(5, "Unwrapped backup key has the wrong length");
  return new Uint8Array(key);
}

export function manifestAad(client: string, seq: number): Uint8Array {
  return Buffer.from(`manifest:${client}:${seq}`, "utf8");
}

export function chunkAad(id: string): Uint8Array {
  return Buffer.from(id, "ascii");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort())
      out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

// Canonical JSON (sorted keys, no whitespace). Manifest hashes are computed
// over this form, so equal manifests always hash equally.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
