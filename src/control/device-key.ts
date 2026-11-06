// Per-device Ed25519 signing identity (ADR-0002). The private key stays in a
// private file beside the control-plane state. It is never synced, never
// logged and never returned by any API; only the public key travels, inside
// the authenticated pairing messages.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory, protect } from "../platform";
import { HomectlError } from "../types";

export interface DeviceKey {
  // Base64 SPKI DER of the Ed25519 public key. Safe to share.
  publicKey: string;
  privateKey: KeyObject;
}

export function deviceKeyPath(stateDirectory: string): string {
  return join(stateDirectory, "device-key.json");
}

export function fingerprintOf(publicKey: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 32);
  return digest.match(/.{4}/g)?.join(" ") ?? digest;
}

// Accepts only base64 SPKI DER of an Ed25519 key.
export function validateSigningKey(publicKey: string): void {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType === "ed25519") return;
  } catch {
    /* fall through to the fixed message */
  }
  throw new HomectlError(2, "Invalid device signing key");
}

// Creates the key on first use; later calls load the same key.
export async function loadOrCreateDeviceKey(
  stateDirectory: string,
): Promise<DeviceKey> {
  // The directory is secured when the key is created; loads do not repeat the ACL work.
  const path = deviceKeyPath(stateDirectory);
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new HomectlError(5, "Device key cannot be read");
  }
  if (text === undefined) {
    await privateDirectory(stateDirectory);
    const pair = generateKeyPairSync("ed25519");
    const record = {
      version: 1,
      publicKey: pair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      privateKey: pair.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
    await writeFile(path, JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    }).catch(async (error) => {
      // Another process created it first: load that key instead.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    await protect(path);
    return loadOrCreateDeviceKey(stateDirectory);
  }
  try {
    const record = JSON.parse(text) as {
      version: number;
      publicKey: string;
      privateKey: string;
    };
    if (record.version !== 1) throw new Error("version");
    validateSigningKey(record.publicKey);
    return {
      publicKey: record.publicKey,
      privateKey: createPrivateKey(record.privateKey),
    };
  } catch {
    throw new HomectlError(
      5,
      "Device key file is corrupt; restore it or re-pair this device",
    );
  }
}

export function signBytes(key: KeyObject, message: string): string {
  return sign(null, Buffer.from(message), key).toString("base64");
}

export function verifyBytes(
  publicKey: string,
  message: string,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(message),
      createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function isSigningKey(publicKey: string): boolean {
  try {
    validateSigningKey(publicKey);
    return true;
  } catch {
    return false;
  }
}
