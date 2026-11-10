import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import {
  createRecoveryKey,
  exportRecoveryBundle,
  recoveryKeyId,
  restoreRecoveryBundle,
} from "../src/control/recovery";
import { HomectlError } from "../src/types";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

// A device with a real device key and some control state.
async function device() {
  const root = await mkdtemp(join(tmpdir(), "homectl-recovery-"));
  cleanup.push(root);
  const state = join(root, "control-plane");
  await mkdir(state, { recursive: true });
  await loadOrCreateDeviceKey(state);
  await writeFile(
    join(state, "replica.json"),
    JSON.stringify({ version: 1, replica: { ops: {} } }),
  );
  await writeFile(
    join(state, "state.json"),
    JSON.stringify({ operations: {} }),
  );
  return { root, state };
}

async function freshState(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "homectl-restore-"));
  cleanup.push(root);
  return join(root, "control-plane");
}

async function failureOf(work: Promise<unknown>): Promise<HomectlError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HomectlError) return error;
    throw error;
  }
  throw new Error("expected the operation to fail");
}

describe("recovery key", () => {
  test("is 32 random bytes, written once, and never inside the state directory", async () => {
    const { root, state } = await device();
    const path = join(root, "recovery.key");
    const made = await createRecoveryKey(state, path);
    const key = Buffer.from((await readFile(path, "utf8")).trim(), "base64");
    expect(key.length).toBe(32);
    expect(made.keyId).toBe(recoveryKeyId(key));
    expect((await failureOf(createRecoveryKey(state, path)))?.code).toBe(3);
    expect(
      (await failureOf(createRecoveryKey(state, join(state, "k.key"))))?.code,
    ).toBe(2);
  });
});

describe("recovery bundle", () => {
  test("restores the same device identity and control files onto an empty state directory", async () => {
    const original = await device();
    const keyPath = join(original.root, "recovery.key");
    await createRecoveryKey(original.state, keyPath);
    const bundlePath = join(original.root, "bundle.json");
    const exported = await exportRecoveryBundle({
      stateDirectory: original.state,
      keyPath,
      outPath: bundlePath,
    });
    expect(exported.files).toEqual(
      expect.arrayContaining(["device-key.json", "replica.json", "state.json"]),
    );

    // The bundle is ciphertext: none of the plaintext fields show through.
    const text = await readFile(bundlePath, "utf8");
    expect(text).not.toContain('"publicKey"');
    expect(text).not.toContain('"ops"');

    const target = await freshState();
    const restored = await restoreRecoveryBundle({
      stateDirectory: target,
      keyPath,
      bundlePath,
    });
    expect(restored.restored).toEqual(
      expect.arrayContaining(["device-key.json", "replica.json", "state.json"]),
    );
    for (const name of ["device-key.json", "replica.json", "state.json"])
      expect(await readFile(join(target, name), "utf8")).toBe(
        await readFile(join(original.state, name), "utf8"),
      );
  });

  test("a wrong recovery key is refused and nothing is written", async () => {
    const original = await device();
    const keyPath = join(original.root, "recovery.key");
    await createRecoveryKey(original.state, keyPath);
    const bundlePath = join(original.root, "bundle.json");
    await exportRecoveryBundle({
      stateDirectory: original.state,
      keyPath,
      outPath: bundlePath,
    });
    const other = join(original.root, "other.key");
    await createRecoveryKey(original.state, other);
    const target = await freshState();
    const error = await failureOf(
      restoreRecoveryBundle({
        stateDirectory: target,
        keyPath: other,
        bundlePath,
      }),
    );
    expect(error.code).toBe(5);
    expect(error.message).toContain("does not match");
    await expect(stat(join(target, "device-key.json"))).rejects.toThrow();
  });

  test("a changed bundle does not open, and nothing is written", async () => {
    const original = await device();
    const keyPath = join(original.root, "recovery.key");
    await createRecoveryKey(original.state, keyPath);
    const bundlePath = join(original.root, "bundle.json");
    await exportRecoveryBundle({
      stateDirectory: original.state,
      keyPath,
      outPath: bundlePath,
    });
    const envelope = JSON.parse(await readFile(bundlePath, "utf8")) as {
      ciphertext: string;
    };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    envelope.ciphertext = bytes.toString("base64");
    await writeFile(bundlePath, JSON.stringify(envelope));
    const target = await freshState();
    const error = await failureOf(
      restoreRecoveryBundle({ stateDirectory: target, keyPath, bundlePath }),
    );
    expect(error.code).toBe(5);
    expect(error.message).toContain("does not open");
    await expect(stat(join(target, "device-key.json"))).rejects.toThrow();
  });

  test("restore refuses a state directory that already holds a device", async () => {
    const original = await device();
    const keyPath = join(original.root, "recovery.key");
    await createRecoveryKey(original.state, keyPath);
    const bundlePath = join(original.root, "bundle.json");
    await exportRecoveryBundle({
      stateDirectory: original.state,
      keyPath,
      outPath: bundlePath,
    });
    const error = await failureOf(
      restoreRecoveryBundle({
        stateDirectory: original.state,
        keyPath,
        bundlePath,
      }),
    );
    expect(error.code).toBe(3);
  });

  test("a bundle with an unexpected file name is refused, even when it is authentic", async () => {
    const root = await mkdtemp(join(tmpdir(), "homectl-evil-"));
    cleanup.push(root);
    const keyPath = join(root, "recovery.key");
    await createRecoveryKey(join(root, "unused"), keyPath);
    const key = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
    // Sealed with the real key, so only the file-name check can refuse it.
    const aad = JSON.stringify({
      version: 1,
      alg: "aes-256-gcm",
      keyId: recoveryKeyId(key),
      createdAt: new Date().toISOString(),
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(aad));
    const plaintext = JSON.stringify({
      files: {
        "device-key.json": Buffer.from('{"publicKey":"x"}').toString("base64"),
        "../escape.json": Buffer.from("x").toString("base64"),
      },
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const bundlePath = join(root, "bundle.json");
    await writeFile(
      bundlePath,
      JSON.stringify({
        aad,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
    );
    const error = await failureOf(
      restoreRecoveryBundle({
        stateDirectory: await freshState(),
        keyPath,
        bundlePath,
      }),
    );
    expect(error.code).toBe(5);
    expect(error.message).toContain("unexpected file");
  });
});
