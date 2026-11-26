// KDBX database files: create, open and atomic save. Entry logic lives in
// entries.ts; sessions and access control live in session.ts.
import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as kdbx from "kdbxweb";
import { atomicReplace, privateDirectory, protect } from "../platform";
import { HomectlError } from "../types";
import { assertArgon2 } from "./argon2";
import { type CredentialSource, kdbxCredentials } from "./credentials";
import { ensureGroup, GROUPS } from "./groups";
import type { Argon2Params } from "./types";

export type DatabaseOptions = { argon2?: Argon2Params };

export class VaultDatabase {
  constructor(
    readonly path: string,
    readonly db: kdbx.Kdbx,
  ) {}

  // Replaces the file atomically. Used for every write to an existing vault.
  async save(): Promise<void> {
    await writeSecureFile(this.path, await this.serialize(), true);
  }

  // Creates the file; never overwrites an existing one.
  async saveNew(): Promise<void> {
    await writeSecureFile(this.path, await this.serialize(), false);
  }

  private async serialize(): Promise<Uint8Array> {
    const bytes = new Uint8Array(await this.db.save());
    return bytes;
  }
}

// Writes bytes via a private temp file. With replace=false, `link` fails if the
// destination exists, so an existing file is never overwritten.
export async function writeSecureFile(
  path: string,
  bytes: Uint8Array,
  replace: boolean,
): Promise<void> {
  await privateDirectory(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600, flag: "wx" });
  try {
    await protect(tmp);
    if (replace) {
      await atomicReplace(tmp, path);
      return;
    }
    try {
      await link(tmp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new HomectlError(3, "Refusing to overwrite an existing file");
      throw error;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

function applyKdf(db: kdbx.Kdbx, argon2?: Argon2Params): void {
  if (!argon2) return;
  assertArgon2(argon2);
  db.setKdf(kdbx.Consts.KdfId.Argon2d);
  const parameters = db.header.kdfParameters;
  if (!parameters) throw new HomectlError(5, "KDBX KDF parameters unavailable");
  const { ValueType } = kdbx.VarDictionary;
  parameters.set("M", ValueType.UInt64, new kdbx.Int64(argon2.memory * 1024));
  parameters.set("I", ValueType.UInt64, new kdbx.Int64(argon2.iterations));
  parameters.set("P", ValueType.UInt32, argon2.parallelism);
}

// In-memory database with the homectl group layout. Removed entries are deleted
// outright rather than moved to a recycle bin, so secrets leave the file.
export async function newDatabase(
  path: string,
  source: CredentialSource,
  options: DatabaseOptions = {},
): Promise<VaultDatabase> {
  const credentials = await kdbxCredentials(source);
  const db = kdbx.Kdbx.create(credentials, "homectl");
  db.meta.recycleBinEnabled = false;
  applyKdf(db, options.argon2);
  for (const group of Object.values(GROUPS)) ensureGroup(db, group);
  return new VaultDatabase(path, db);
}

export async function createDatabase(
  path: string,
  source: CredentialSource,
  options: DatabaseOptions = {},
): Promise<VaultDatabase> {
  const database = await newDatabase(path, source, options);
  await database.saveNew();
  return database;
}

export async function openDatabase(
  path: string,
  source: CredentialSource,
): Promise<VaultDatabase> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new HomectlError(5, "Vault database unavailable");
  }
  const credentials = await kdbxCredentials(source);
  try {
    const db = await kdbx.Kdbx.load(Uint8Array.from(bytes).buffer, credentials);
    return new VaultDatabase(path, db);
  } catch {
    throw new HomectlError(
      5,
      "Vault unlock failed; password or database unavailable. Details suppressed.",
    );
  }
}
