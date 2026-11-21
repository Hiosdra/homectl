import { dirname } from "node:path";
import { available, privateDirectory, protect } from "../platform";
import { HomectlError, type Inventory } from "../types";
import { privateCommand, readPassword, sessionConfig } from ".";

export const VAULT_PASSWORD_MIN = 12;

// Asks for the new vault password from the terminal, then again to confirm.
async function readVaultPassword(): Promise<string> {
  const password = await readPassword(
    "New vault password (this is also your owner password): ",
  );
  if (password.length < VAULT_PASSWORD_MIN)
    throw new HomectlError(
      2,
      `Use a vault password of at least ${VAULT_PASSWORD_MIN} characters. It is also your owner password.`,
    );
  if (password !== (await readPassword("Repeat the vault password: ")))
    throw new HomectlError(2, "Passwords differ");
  return password;
}

// `suppliedPassword` is for the guided setup, which has already asked for the
// password and checked it. Without it the password is read from the terminal.
export async function initDatabase(
  inv: Inventory,
  inventoryPath: string,
  suppliedPassword?: string,
) {
  const { database } = sessionConfig(inv, inventoryPath);
  if (await Bun.file(database).exists())
    throw new HomectlError(
      3,
      "Database already exists; it will not be overwritten",
    );
  if (!available("keepassxc-cli"))
    throw new HomectlError(5, "Install KeePassXC first");
  // The vault password is also the owner password: signing in to the panel
  // with it opens the vault. Same minimum as the owner password (broker/owner.ts).
  const password = suppliedPassword ?? (await readVaultPassword());
  if (password.length < VAULT_PASSWORD_MIN)
    throw new HomectlError(
      2,
      `Use a vault password of at least ${VAULT_PASSWORD_MIN} characters. It is also your owner password.`,
    );
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
    next: "Your owner password is this vault password. Next: run home-ctl start, then sign in to the panel with it. Add a machine with home-ctl key create <name> in a private terminal.",
  };
}
