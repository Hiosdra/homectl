import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProtectedValue } from "kdbxweb";
import { privateDirectory, protect } from "../platform";
import { publicBlob } from "../session/agent";
import { keyReference } from "../session/keys";
import { normalizePublicKey } from "../session/public-key";
import { HomectlError } from "../types";
import {
  findUnique,
  isAdmin,
  managedEntries,
  readSshKey,
  SSH_ATTACHMENT,
  upsertSecret,
} from "./entries";
import { GROUPS } from "./groups";
import type { VaultSession } from "./session";

// A public file is only a projection of the encrypted vault. Persist the key
// first. If writing its public half fails, a retry uses the same stored key.
export async function createMachineKey(
  session: VaultSession,
  inventoryPath: string,
  name: string,
): Promise<void> {
  const auth = keyReference(name, inventoryPath);
  const publicKey = await session.mutate(async ({ db }) => {
    const entry = findUnique(managedEntries(db), auth.entry);
    if (entry) {
      if (isAdmin(entry) || !entry.binaries.has(SSH_ATTACHMENT))
        throw new HomectlError(
          3,
          "A different vault entry already uses this name",
        );
      const key = readSshKey(entry);
      try {
        return key.publicKey;
      } finally {
        key.privateKey.fill(0);
      }
    }
    if (await Bun.file(auth.public_key).exists())
      throw new HomectlError(
        3,
        "A public key already exists without a matching vault entry",
      );
    const pair = generateKeyPairSync("ed25519");
    const passphrase = randomBytes(32).toString("base64url");
    const encrypted = pair.privateKey.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase,
    });
    const attachment = await db.createBinary(
      ProtectedValue.fromString(encrypted),
    );
    const created = upsertSecret(
      db,
      auth.entry,
      { Password: passphrase },
      { group: GROUPS.ssh },
    );
    created.binaries.set(SSH_ATTACHMENT, attachment);
    return `ssh-ed25519 ${publicBlob(pair.privateKey).toString("base64")}`;
  });
  await privateDirectory(dirname(auth.public_key));
  try {
    await writeFile(auth.public_key, `${publicKey}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await protect(auth.public_key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      normalizePublicKey(await readFile(auth.public_key, "utf8")) !== publicKey
    )
      throw new HomectlError(
        3,
        "Existing public key differs from the vault key",
      );
  }
}
