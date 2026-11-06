import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprintOf,
  isSigningKey,
  loadOrCreateDeviceKey,
  signBytes,
  verifyBytes,
} from "../src/control/device-key";
import { validateIdentity } from "../src/peer/pairing";
import { windows } from "../src/platform";

async function dir() {
  return mkdtemp(join(tmpdir(), "homectl-device-"));
}

test("a device key is created once, stored privately and reloaded unchanged", async () => {
  const d = await dir();
  try {
    const first = await loadOrCreateDeviceKey(d);
    const second = await loadOrCreateDeviceKey(d);
    expect(second.publicKey).toBe(first.publicKey);
    expect(isSigningKey(first.publicKey)).toBe(true);
    if (!windows)
      expect((await stat(join(d, "device-key.json"))).mode & 0o777).toBe(0o600);
    // Only the public key is ever returned to callers.
    expect(Object.keys(first).sort()).toEqual(["privateKey", "publicKey"]);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("signatures verify only with the signing key and only for the signed bytes", async () => {
  const d = await dir();
  try {
    const key = await loadOrCreateDeviceKey(d);
    const other = await loadOrCreateDeviceKey(await dir());
    const sig = signBytes(key.privateKey, "approve:op-1:fp");
    expect(verifyBytes(key.publicKey, "approve:op-1:fp", sig)).toBe(true);
    expect(verifyBytes(key.publicKey, "approve:op-1:other", sig)).toBe(false);
    expect(verifyBytes(other.publicKey, "approve:op-1:fp", sig)).toBe(false);
    expect(verifyBytes(key.publicKey, "approve:op-1:fp", "AAAA")).toBe(false);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("fingerprints are short, grouped and stable for out-of-band comparison", async () => {
  const d = await dir();
  try {
    const key = await loadOrCreateDeviceKey(d);
    const fp = fingerprintOf(key.publicKey);
    expect(fp).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(fingerprintOf(key.publicKey)).toBe(fp);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("a corrupt device key file is refused, not replaced silently", async () => {
  const d = await dir();
  try {
    await loadOrCreateDeviceKey(d);
    const path = join(d, "device-key.json");
    const text = await readFile(path, "utf8");
    await (await import("node:fs/promises")).writeFile(
      path,
      text.replace(/"publicKey":"[^"]+"/, '"publicKey":"AAAA"'),
    );
    await expect(loadOrCreateDeviceKey(d)).rejects.toMatchObject({ code: 5 });
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("pairing identities accept an optional Ed25519 signing key and refuse other keys", async () => {
  const d = await dir();
  try {
    const key = await loadOrCreateDeviceKey(d);
    const base = {
      id: crypto.randomUUID(),
      name: "Linux demo",
      platform: "linux" as const,
    };
    expect(() => validateIdentity(base)).not.toThrow();
    expect(() =>
      validateIdentity({ ...base, signingKey: key.publicKey }),
    ).not.toThrow();
    expect(() => validateIdentity({ ...base, signingKey: "AAAA" })).toThrow();
    expect(() => validateIdentity({ ...base, signingKey: "" })).toThrow();
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
