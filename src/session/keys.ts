import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { type Auth, HomectlError, type Inventory } from "../types";
import {
  databaseCommand,
  loadKey,
  privateCommand,
  readPassword,
  sessionConfig,
  sessionPaths,
  startSession,
} from ".";
import { normalizePublicKey } from "./public-key";

export function keyReference(name: string, inventoryPath: string): Auth {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    throw new HomectlError(2, "Invalid key name");
  const p = sessionPaths(inventoryPath);
  return {
    type: "keepassxc",
    entry: `homectl-${name}`,
    socket: p.socket,
    public_key: join(p.keys, `${name}.pub`),
  };
}

export async function createKey(
  name: string,
  inv: Inventory,
  inventoryPath: string,
) {
  const auth = keyReference(name, inventoryPath);
  const { database } = sessionConfig(inv, inventoryPath);
  if (!Bun.which("keepassxc-cli"))
    throw new HomectlError(5, "Install KeePassXC first");
  if (!(await Bun.file(database).exists()))
    throw new HomectlError(5, "Run homectl session init privately first");
  if (
    process.platform !== "linux" ||
    Number((await statfs("/dev/shm")).type) !== 0x01021994
  )
    throw new HomectlError(
      5,
      "Automatic key creation requires Linux tmpfs. On macOS import a key into KeePassXC privately; see README.",
    );
  const password = await readPassword();
  const entries = (
    await databaseCommand(database, password, ["ls", "--flatten"])
  )
    .toString()
    .split("\n");
  const reused = entries.includes(auth.entry);
  const staging = await mkdtemp("/dev/shm/homectl-key-");
  await chmod(staging, 0o700);
  const privateFile = join(staging, "id_ed25519");
  let key: Buffer | undefined;
  try {
    if (reused) {
      key = await databaseCommand(database, password, [
        "attachment-export",
        "--stdout",
        auth.entry,
        "id_ed25519",
      ]);
      await writeFile(privateFile, key, { mode: 0o600, flag: "wx" });
    } else {
      const backup = `${database}.before-key-${Date.now()}`;
      await copyFile(database, backup);
      await chmod(backup, 0o600);
      await privateCommand([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        auth.entry,
        "-f",
        privateFile,
      ]);
      key = await readFile(privateFile);
      await databaseCommand(database, password, [
        "add",
        auth.entry,
        "--notes",
        "homectl SSH key; encrypted id_ed25519 attachment",
      ]);
      await databaseCommand(database, password, [
        "attachment-import",
        auth.entry,
        "id_ed25519",
        privateFile,
      ]);
    }
    const publicKey = normalizePublicKey(
      (
        await privateCommand(["ssh-keygen", "-y", "-f", privateFile])
      ).toString(),
    );
    await mkdir(sessionPaths(inventoryPath).keys, {
      recursive: true,
      mode: 0o700,
    });
    if (await Bun.file(auth.public_key).exists()) {
      if (
        normalizePublicKey(await readFile(auth.public_key, "utf8")) !==
        publicKey
      )
        throw new HomectlError(
          3,
          "Existing public key differs; refusing to replace it",
        );
    } else
      await writeFile(auth.public_key, `${publicKey}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    const state = await startSession(inv, inventoryPath);
    await loadKey(key, inventoryPath, state);
    return {
      name,
      auth,
      reused,
      next: "Install only this public key through your existing trusted access, then enroll the host. See README.",
    };
  } finally {
    key?.fill(0);
    // Owned, newly generated tmpfs artifacts only; no user files are removed.
    await rm(staging, { recursive: true, force: true });
  }
}
