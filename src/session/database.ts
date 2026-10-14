import { dirname } from "node:path";
import { available, privateDirectory, protect } from "../platform";
import { HomectlError, type Inventory } from "../types";
import { privateCommand, readPassword, sessionConfig } from ".";

export async function initDatabase(inv: Inventory, inventoryPath: string) {
  const { database } = sessionConfig(inv, inventoryPath);
  if (await Bun.file(database).exists())
    throw new HomectlError(
      3,
      "Database already exists; it will not be overwritten",
    );
  if (!available("keepassxc-cli"))
    throw new HomectlError(5, "Install KeePassXC first");
  const password = await readPassword("New homelab database password: ");
  if (password !== (await readPassword("Repeat database password: ")))
    throw new HomectlError(2, "Passwords differ");
  await privateDirectory(dirname(database));
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
  await protect(database);
  return {
    database,
    created: true,
    next: "Run homectl key create <host> in your private terminal",
  };
}
