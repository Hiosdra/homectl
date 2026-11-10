// Owner recovery key (ADR-0002 follow-up, option A). A random 256-bit key is kept
// outside every device. It encrypts a bundle of one device's control state so a
// lost device can be restored with the same identity. The device never keeps the
// key. The bundle is AES-256-GCM, and its header is authenticated as AAD.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { privateDirectory, protect } from "../platform";
import { HomectlError } from "../types";

export const RECOVERY_BUNDLE_VERSION = 1;

// The files that make up one device's control state, relative to its state directory.
export const RECOVERY_FILES = [
  "device-key.json",
  "replica.json",
  "state.json",
  "audit.jsonl",
  "audit.anchor",
] as const;

type RecoveryFile = (typeof RECOVERY_FILES)[number];

interface BundleEnvelope {
  // The authenticated header, as text. It is the AAD, so it is never re-serialized.
  aad: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Shows a key as a short identifier. The key itself is never printed.
export function recoveryKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function readKey(path: string): Promise<Buffer> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new HomectlError(5, "Recovery key file cannot be read");
  }
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32 || key.toString("base64") !== text.trim())
    throw new HomectlError(5, "Recovery key file is not a valid 32-byte key");
  return key;
}

// Writes a new key. Refuses to overwrite and refuses a path inside the state directory.
export async function createRecoveryKey(
  stateDirectory: string,
  outPath: string,
): Promise<{ keyId: string; path: string }> {
  if (isInside(stateDirectory, outPath))
    throw new HomectlError(
      2,
      "Keep the recovery key outside the control state directory; a key next to the state is no separate backup",
    );
  const key = randomBytes(32);
  try {
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(outPath, `${key.toString("base64")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new HomectlError(
        3,
        "Recovery key file already exists; choose another path or remove it deliberately",
      );
    throw new HomectlError(5, "Recovery key file cannot be written");
  }
  await protect(outPath);
  return { keyId: recoveryKeyId(key), path: resolve(outPath) };
}

export async function exportRecoveryBundle(options: {
  stateDirectory: string;
  keyPath: string;
  outPath: string;
  clock?: () => Date;
}): Promise<{ keyId: string; files: string[]; path: string }> {
  if (isInside(options.stateDirectory, options.keyPath))
    throw new HomectlError(
      2,
      "The recovery key must live outside the control state directory",
    );
  const key = await readKey(options.keyPath);
  const files: Partial<Record<RecoveryFile, string>> = {};
  for (const name of RECOVERY_FILES) {
    try {
      files[name] = (
        await readFile(join(options.stateDirectory, name))
      ).toString("base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new HomectlError(5, "Control state cannot be read");
    }
  }
  if (files["device-key.json"] === undefined)
    throw new HomectlError(
      3,
      "This state directory has no device key; there is nothing to recover",
    );
  const keyId = recoveryKeyId(key);
  const aad = JSON.stringify({
    version: RECOVERY_BUNDLE_VERSION,
    alg: "aes-256-gcm",
    keyId,
    createdAt: (options.clock?.() ?? new Date()).toISOString(),
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ files })),
    cipher.final(),
  ]);
  const envelope: BundleEnvelope = {
    aad,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  try {
    await mkdir(dirname(resolve(options.outPath)), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(envelope)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new HomectlError(
        3,
        "Bundle file already exists; choose another path",
      );
    throw new HomectlError(5, "Bundle file cannot be written");
  }
  await protect(options.outPath);
  return {
    keyId,
    files: Object.keys(files),
    path: resolve(options.outPath),
  };
}

function parseJsonObject(
  text: string,
  message: string,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Reported below with the same message.
  }
  throw new HomectlError(5, message);
}

export async function restoreRecoveryBundle(options: {
  stateDirectory: string;
  keyPath: string;
  bundlePath: string;
}): Promise<{ keyId: string; restored: string[] }> {
  // Restore only onto an empty state directory. Never overwrite a live device.
  for (const name of RECOVERY_FILES) {
    try {
      await stat(join(options.stateDirectory, name));
      throw new HomectlError(
        3,
        "This device already has control state. Restore only onto an empty state directory.",
      );
    } catch (error) {
      if (error instanceof HomectlError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new HomectlError(5, "Control state cannot be checked");
    }
  }
  const key = await readKey(options.keyPath);
  let envelope: BundleEnvelope;
  try {
    envelope = JSON.parse(await readFile(options.bundlePath, "utf8"));
  } catch {
    throw new HomectlError(5, "Bundle file is not a recovery bundle");
  }
  if (
    typeof envelope?.aad !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    throw new HomectlError(5, "Bundle file is not a recovery bundle");
  const header = parseJsonObject(
    envelope.aad,
    "Bundle file is not a recovery bundle",
  );
  if (header.version !== RECOVERY_BUNDLE_VERSION)
    throw new HomectlError(5, "Unsupported recovery bundle version");
  const keyId = recoveryKeyId(key);
  if (header.keyId !== keyId)
    throw new HomectlError(
      5,
      "This recovery key does not match the bundle (wrong key or wrong bundle)",
    );
  let plaintext: string;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(envelope.aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HomectlError(
      5,
      "Bundle does not open with this recovery key, or it was changed",
    );
  }
  const parsed = parseJsonObject(plaintext, "Bundle contents are malformed");
  const files =
    parsed.files !== null && typeof parsed.files === "object"
      ? (parsed.files as Record<string, unknown>)
      : {};
  const allowed = new Set<string>(RECOVERY_FILES);
  const entries = Object.entries(files);
  if (entries.some(([, data]) => typeof data !== "string"))
    throw new HomectlError(5, "Bundle contents are malformed");
  for (const [name] of entries)
    if (!allowed.has(name))
      throw new HomectlError(5, "Bundle contains an unexpected file");
  const contents = new Map(
    entries.map(([name, data]) => [
      name,
      Buffer.from(data as string, "base64"),
    ]),
  );
  // Check the important files before anything is written.
  const deviceKey = contents.get("device-key.json")?.toString("utf8");
  if (deviceKey === undefined)
    throw new HomectlError(5, "Bundle has no device key");
  const keyRecord = parseJsonObject(
    deviceKey,
    "Bundle device key is malformed",
  );
  if (typeof keyRecord.publicKey !== "string")
    throw new HomectlError(5, "Bundle device key is malformed");
  const replica = contents.get("replica.json")?.toString("utf8");
  if (replica !== undefined) {
    const parsedReplica = parseJsonObject(
      replica,
      "Bundle replica state is malformed",
    );
    if (
      typeof parsedReplica.replica !== "object" ||
      parsedReplica.replica === null
    )
      throw new HomectlError(5, "Bundle replica state is malformed");
  }

  await privateDirectory(options.stateDirectory);
  const staged: Array<{ tmp: string; target: string }> = [];
  const placed: string[] = [];
  try {
    for (const [name, data] of contents) {
      const target = join(options.stateDirectory, name as RecoveryFile);
      const tmp = `${target}.restore-${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
      staged.push({ tmp, target });
    }
    for (const { tmp, target } of staged) {
      await rename(tmp, target);
      placed.push(target);
      await protect(target);
    }
  } catch {
    // Remove what this restore created, so a failed restore can simply be rerun.
    for (const { tmp } of staged)
      await rm(tmp, { force: true }).catch(() => {});
    for (const target of placed)
      await rm(target, { force: true }).catch(() => {});
    throw new HomectlError(
      5,
      "Restore failed; no files were kept. Rerun the restore.",
    );
  }
  return { keyId, restored: [...contents.keys()] };
}
