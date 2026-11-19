// Release trust for self-update (homelab #21, matrix U2).
//
// A release publishes two files next to its archives:
//   manifest.json      {schema, version, artifacts: [{name, platform, arch, libc?, sha256, size}]}
//   manifest.json.sig  {algorithm: "ed25519", keyId, signature} (hex), over the exact manifest bytes
// A build installs an update only when the manifest signature verifies with a key listed
// below, the manifest is for the requested version and is newer than the running build, and
// the archive for this platform matches its sha256. Anything else is refused before a byte
// is unpacked.
//
// Key rotation: append the new public key to RELEASE_SIGNING_KEYS in a release that is
// still signed by the old key, so builds that update to it trust both. Once no supported
// build needs the old key, move its keyId to REVOKED_RELEASE_KEY_IDS (revocation wins).
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { HomectlError } from "./types";

// Public keys (32-byte Ed25519, hex) this build accepts as release signers.
// No key is embedded yet: the signing key is generated and held by the owner, and only its
// public half is added here. Until then this build refuses every automatic update, which
// is the intended fail-closed behaviour.
export const RELEASE_SIGNING_KEYS: readonly string[] = [];

// keyIds (see keyIdOf) that must no longer be accepted, even if still listed above.
export const REVOKED_RELEASE_KEY_IDS: readonly string[] = [];

export const MANIFEST_NAME = "manifest.json";
export const SIGNATURE_NAME = "manifest.json.sig";

export interface ReleaseArtifact {
  name: string;
  platform: string;
  arch: string;
  libc?: "glibc" | "musl";
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schema: 1;
  version: string;
  artifacts: ReleaseArtifact[];
}

export interface ManifestSignature {
  algorithm: "ed25519";
  keyId: string;
  signature: string;
}

export interface TrustPolicy {
  keys?: readonly string[];
  revoked?: readonly string[];
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;
const BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A short, stable name for a public key: what the signature file and the rotation lists use.
export function keyIdOf(publicKeyHex: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKeyHex, "hex"))
    .digest("hex");
  return `ed25519-${digest.slice(0, 16)}`;
}

// Dotted numeric compare of the first three numbers; anything else is treated as 0.
export function compareVersions(a: string, b: string): number {
  const parts = (text: string) =>
    /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim())?.slice(1, 4).map(Number) ?? [
      0, 0, 0,
    ];
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function verifySignature(
  manifestBytes: Uint8Array,
  signatureText: string,
  policy: TrustPolicy = {},
): { keyId: string } {
  const keys = policy.keys ?? RELEASE_SIGNING_KEYS;
  const revoked = policy.revoked ?? REVOKED_RELEASE_KEY_IDS;
  if (keys.length === 0)
    throw new HomectlError(
      2,
      "This homectl build has no release signing key, so it cannot install updates automatically. Install the newer release from the release page.",
    );
  let parsed: Partial<ManifestSignature>;
  try {
    parsed = JSON.parse(signatureText) as Partial<ManifestSignature>;
  } catch {
    throw new HomectlError(5, "The release signature file is not valid JSON.");
  }
  if (
    parsed.algorithm !== "ed25519" ||
    typeof parsed.keyId !== "string" ||
    typeof parsed.signature !== "string" ||
    !HEX64.test(parsed.signature)
  )
    throw new HomectlError(5, "The release signature file is malformed.");
  const signer = keys.find((key) => keyIdOf(key) === parsed.keyId);
  if (!signer || revoked.includes(parsed.keyId))
    throw new HomectlError(
      5,
      "The release is signed by a key this homectl build does not trust. Nothing was installed.",
    );
  const valid = ed25519.verify(
    Buffer.from(parsed.signature, "hex"),
    manifestBytes,
    Buffer.from(signer, "hex"),
  );
  if (!valid)
    throw new HomectlError(
      5,
      "The release signature does not verify. Nothing was installed.",
    );
  return { keyId: parsed.keyId };
}

// Parses a manifest that has already passed its signature check. Field shapes are still
// validated: a signed but malformed manifest is refused, not guessed at.
export function parseManifest(manifestBytes: Uint8Array): ReleaseManifest {
  let value: Partial<ReleaseManifest>;
  try {
    value = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new HomectlError(5, "The release manifest is not valid JSON.");
  }
  if (
    value.schema !== 1 ||
    typeof value.version !== "string" ||
    !Array.isArray(value.artifacts)
  )
    throw new HomectlError(5, "The release manifest has an unknown format.");
  for (const artifact of value.artifacts) {
    if (
      typeof artifact?.name !== "string" ||
      !BASENAME.test(artifact.name) ||
      typeof artifact.platform !== "string" ||
      typeof artifact.arch !== "string" ||
      typeof artifact.sha256 !== "string" ||
      !HEX32.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0
    )
      throw new HomectlError(5, "The release manifest lists a malformed file.");
  }
  return value as ReleaseManifest;
}

// The manifest must describe exactly the version that was requested and be newer than
// the running build. A correctly signed older manifest is a downgrade, and is refused.
export function checkCandidate(
  manifest: ReleaseManifest,
  options: { requested: string; current: string },
) {
  const requested = options.requested.replace(/^v/, "");
  if (manifest.version !== requested)
    throw new HomectlError(
      5,
      `The release manifest is for ${manifest.version}, not ${requested}. Nothing was installed.`,
    );
  if (compareVersions(manifest.version, options.current) <= 0)
    throw new HomectlError(
      5,
      `Refusing to install ${manifest.version}: it is not newer than the running ${options.current} (downgrade).`,
    );
}

export function selectArtifact(
  manifest: ReleaseManifest,
  target: { platform: string; arch: string; libc?: "glibc" | "musl" },
): ReleaseArtifact {
  const matches = manifest.artifacts.filter(
    (artifact) =>
      artifact.platform === target.platform &&
      artifact.arch === target.arch &&
      (artifact.libc ?? undefined) === target.libc,
  );
  if (matches.length === 0)
    throw new HomectlError(
      2,
      `The release has no build for ${target.platform} ${target.arch}. Install the newer release from the release page on this platform.`,
    );
  if (matches.length > 1)
    throw new HomectlError(
      5,
      `The release lists ${matches.length} builds for ${target.platform} ${target.arch}; refusing to guess.`,
    );
  return matches[0] as ReleaseArtifact;
}

export function checkArchive(artifact: ReleaseArtifact, bytes: Uint8Array) {
  if (bytes.byteLength !== artifact.size)
    throw new HomectlError(
      5,
      "The downloaded release does not match its manifest. Nothing was installed.",
    );
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256)
    throw new HomectlError(
      5,
      "The downloaded release does not match its checksum. Nothing was installed.",
    );
}

// Signing side, used by scripts/sign-release.ts. The seed never leaves the caller.
export function signManifest(
  manifestBytes: Uint8Array,
  seedHex: string,
): ManifestSignature {
  if (!HEX32.test(seedHex))
    throw new HomectlError(2, "The signing key must be 32 bytes of hex.");
  const seed = Buffer.from(seedHex, "hex");
  const publicKey = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");
  const signature = Buffer.from(ed25519.sign(manifestBytes, seed)).toString(
    "hex",
  );
  return { algorithm: "ed25519", keyId: keyIdOf(publicKey), signature };
}

export function publicKeyOf(seedHex: string): string {
  return Buffer.from(
    ed25519.getPublicKey(Buffer.from(seedHex, "hex")),
  ).toString("hex");
}
