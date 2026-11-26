// KeePassXC-compatible import and export. Both sides use standard KDBX, so the
// files open in KeePassXC. Imports only read the external file; exports refuse to
// overwrite.
import { HomectlError } from "../types";
import type { CredentialSource } from "./credentials";
import {
  classify,
  copyEntry,
  findUnique,
  groupForKind,
  isAdmin,
  liveEntries,
  managedEntries,
  validateName,
} from "./entries";
import { ensureGroup } from "./groups";
import { newDatabase, openDatabase } from "./kdbx";
import type { VaultSession } from "./session";
import type { Argon2Params } from "./types";

export type TransferResult = { names: string[] };

function distinctNames(names: readonly string[]): string[] {
  if (names.length === 0 || new Set(names).size !== names.length)
    throw new HomectlError(2, "Choose at least one distinct entry");
  for (const name of names) validateName(name);
  return [...names];
}

// Copies selected entries from an external KDBX file into the vault. Admin
// entries need a privileged session. Existing names are refused, never merged.
export async function importFrom(
  externalPath: string,
  password: CredentialSource,
  entryNames: string[],
  session: VaultSession,
): Promise<TransferResult> {
  const names = distinctNames(entryNames);
  const external = await openDatabase(externalPath, password);
  const candidates = liveEntries(external.db);
  const chosen = names.map((name) => {
    const entry = findUnique(candidates, name);
    if (!entry)
      throw new HomectlError(2, `No such entry in external file: ${name}`);
    return entry;
  });
  if (chosen.some((entry) => isAdmin(entry))) session.requirePrivileged();
  await session.mutate(async (database) => {
    const existing = managedEntries(database.db);
    for (const name of names)
      if (findUnique(existing, name))
        throw new HomectlError(3, `Entry already exists: ${name}`);
    for (const source of chosen)
      await copyEntry(
        source,
        database.db,
        ensureGroup(database.db, groupForKind(classify(source))),
      );
  });
  return { names };
}

// Writes selected vault entries to a new KDBX file. Requires a privileged session
// because exports carry secret values out of the vault.
export async function exportTo(
  path: string,
  password: CredentialSource,
  entryNames: string[],
  session: VaultSession,
  options: { argon2?: Argon2Params } = {},
): Promise<TransferResult> {
  session.requirePrivileged();
  const names = distinctNames(entryNames);
  const source = managedEntries(session.activeDatabase().db);
  const chosen = names.map((name) => {
    const entry = findUnique(source, name);
    if (!entry) throw new HomectlError(2, `No such entry: ${name}`);
    return entry;
  });
  const target = await newDatabase(path, password, options);
  for (const entry of chosen)
    await copyEntry(
      entry,
      target.db,
      ensureGroup(target.db, groupForKind(classify(entry))),
    );
  await target.saveNew();
  return { names };
}
