import { generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { available, privateDirectory, protect } from "../platform";
import { type Auth, HomectlError, type Inventory } from "../types";
import {
  databaseCommand,
  loadKey,
  readPassword,
  readStoredKey,
  sessionConfig,
  sessionPaths,
  startSession,
} from ".";
import { decodeKey, publicBlob } from "./agent";
import { normalizePublicKey } from "./public-key";

export function keyReference(name: string, inventoryPath: string): Auth {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    throw new HomectlError(2, "Invalid key name");
  const p = sessionPaths(inventoryPath);
  return {
    type: "keepassxc",
    inventory: resolve(inventoryPath),
    entry: `homectl-${name}`,
    socket: p.socket,
    public_key: join(p.keys, `${name}.pub`),
  };
}

export async function createKey(
  name: string,
  inv: Inventory,
  inventoryPath: string,
  passwordPrompt: () => Promise<string> = readPassword,
) {
  const auth = keyReference(name, inventoryPath);
  const { database } = sessionConfig(inv, inventoryPath);
  if (!available("keepassxc-cli"))
    throw new HomectlError(5, "Install KeePassXC first");
  if (!(await Bun.file(database).exists()))
    throw new HomectlError(5, "Run homectl session init privately first");
  const password = await passwordPrompt();
  const entries = (
    await databaseCommand(database, password, ["ls", "--flatten"])
  )
    .toString()
    .split(/\r?\n/);
  const reused = entries.includes(auth.entry);
  let key: Buffer | undefined;
  let staging: string | undefined;
  try {
    if (reused) key = await readStoredKey(database, password, auth.entry);
    else {
      const backup = `${database}.before-key-${Date.now()}`;
      await copyFile(database, backup);
      await protect(backup);
      const pair = generateKeyPairSync("ed25519");
      const passphrase = randomBytes(32).toString("base64url");
      const encrypted = pair.privateKey.export({
        format: "pem",
        type: "pkcs8",
        cipher: "aes-256-cbc",
        passphrase,
      });
      key = Buffer.from(
        pair.privateKey.export({ format: "pem", type: "pkcs8" }),
      );
      staging = await mkdtemp(join(tmpdir(), "homectl-key-"));
      await protect(staging, true);
      const file = join(staging, "encrypted.pem");
      await writeFile(file, encrypted, { mode: 0o600, flag: "wx" });
      await protect(file);
      await databaseCommand(
        database,
        password,
        ["add", "--password-prompt", auth.entry],
        passphrase,
      );
      await databaseCommand(database, password, [
        "attachment-import",
        auth.entry,
        "id_ed25519",
        file,
      ]);
    }
    const pub = normalizePublicKey(
      `ssh-ed25519 ${publicBlob(decodeKey(key)).toString("base64")}`,
    );
    await privateDirectory(sessionPaths(inventoryPath).keys);
    if (await Bun.file(auth.public_key).exists()) {
      if (normalizePublicKey(await readFile(auth.public_key, "utf8")) !== pub)
        throw new HomectlError(3, "Existing public key differs");
    } else {
      await writeFile(auth.public_key, `${pub}\n`, { mode: 0o600, flag: "wx" });
      await protect(auth.public_key);
    }
    const state = await startSession(inv, inventoryPath);
    await loadKey(key, inventoryPath, state);
    return {
      name,
      auth,
      reused,
      next: "Install only this public key through trusted access, then enroll the host.",
    };
  } finally {
    key?.fill(0);
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
