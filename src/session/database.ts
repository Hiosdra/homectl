import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { HomectlError, type Inventory } from "../types";
import { privateCommand, readPassword, sessionConfig } from ".";

export async function initDatabase(inv: Inventory, inventoryPath: string) {
  const { database } = sessionConfig(inv, inventoryPath);
  if (await Bun.file(database).exists())
    throw new HomectlError(
      3,
      "Database already exists; it will not be overwritten",
    );
  if (!Bun.which("keepassxc-cli"))
    throw new HomectlError(5, "Install KeePassXC first");
  const password = await readPassword("New homelab database password: ");
  if (password !== (await readPassword("Repeat database password: ")))
    throw new HomectlError(2, "Passwords differ");
  await mkdir(dirname(database), { recursive: true, mode: 0o700 });
  await privateCommand(
    [
      "keepassxc-cli",
      "db-create",
      "--quiet",
      "--set-password",
      "--decryption-time",
      "1000",
      database,
    ],
    `${password}\n${password}\n`,
  );
  await chmod(database, 0o600);
  return {
    database,
    created: true,
    next: "Run homectl key create <host> in your private terminal",
  };
}
