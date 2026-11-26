// Unattended set (B3B): a separate KDBX holding copies of non-admin entries,
// opened by an always-on device with a random 32-byte key file. Admin entries
// never enter it, and a restricted session re-checks tags on every read.
import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { HomectlError } from "../types";
import type { CredentialSource } from "./credentials";
import {
  classify,
  copyEntry,
  findById,
  findUnique,
  groupForKind,
  isAdmin,
  managedEntries,
  metaOf,
  readFields,
  readSshKey,
  validateName,
} from "./entries";
import { ensureGroup } from "./groups";
import {
  newDatabase,
  openDatabase,
  type VaultDatabase,
  writeSecureFile,
} from "./kdbx";
import type { VaultSession } from "./session";
import type {
  Argon2Params,
  EntryMeta,
  LockReason,
  SshKeyMaterial,
  VaultState,
} from "./types";

export const KEY_BYTES = 32;

export type UnattendedRequest = {
  path: string;
  keyFile: string;
  entries: string[];
  argon2?: Argon2Params;
};

export type UnattendedResult = {
  path: string;
  keyFile: string;
  entries: string[];
};

function keySource(key: Uint8Array): CredentialSource {
  return {
    kind: "keyfile",
    async get() {
      return Uint8Array.from(key);
    },
  };
}

// Reads the key file for an unattended database. It must be exactly 32 bytes.
export function unattendedKeySource(keyFile: string): CredentialSource {
  return {
    kind: "keyfile",
    async get() {
      const raw = await readFile(keyFile);
      try {
        if (raw.length !== KEY_BYTES)
          throw new HomectlError(5, "Unattended key file is malformed");
        return Uint8Array.from(raw);
      } finally {
        raw.fill(0);
      }
    },
  };
}

// Copies the named non-admin entries from an unlocked session into a new
// unattended database. Every name is checked before anything is written.
export async function createUnattended(
  request: UnattendedRequest,
  session: VaultSession,
): Promise<UnattendedResult> {
  const names = request.entries;
  if (names.length === 0 || new Set(names).size !== names.length)
    throw new HomectlError(2, "Choose at least one distinct entry");
  if (request.path === request.keyFile)
    throw new HomectlError(2, "Database and key file must differ");
  const source = managedEntries(session.activeDatabase().db);
  const selected = names.map((name) => {
    validateName(name);
    const entry = findUnique(source, name);
    if (!entry) throw new HomectlError(2, `No such entry: ${name}`);
    if (isAdmin(entry))
      throw new HomectlError(
        2,
        "Admin entries cannot enter the unattended set",
      );
    return entry;
  });
  const key = randomBytes(KEY_BYTES);
  let keyWritten = false;
  try {
    // Written first and exclusively, so an existing key file is never replaced.
    await writeSecureFile(request.keyFile, Uint8Array.from(key), false);
    keyWritten = true;
    const target = await newDatabase(request.path, keySource(key), {
      argon2: request.argon2,
    });
    for (const entry of selected)
      await copyEntry(
        entry,
        target.db,
        ensureGroup(target.db, groupForKind(classify(entry))),
      );
    await target.saveNew();
    return {
      path: request.path,
      keyFile: request.keyFile,
      entries: [...names],
    };
  } catch (error) {
    if (keyWritten) await unlink(request.keyFile).catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

export async function openUnattended(
  path: string,
  keyFile: string,
): Promise<RestrictedSession> {
  const database = await openDatabase(path, unattendedKeySource(keyFile));
  return new RestrictedSession(database);
}

type LockListener = (reason: LockReason) => void;

// Read-only view of an unattended database. It has no elevation and no writes,
// and it never returns admin entries, judged from the tags at read time.
export class RestrictedSession {
  private database: VaultDatabase | undefined;
  private readonly handed: Uint8Array[] = [];
  private readonly listeners = new Set<LockListener>();

  constructor(database: VaultDatabase) {
    this.database = database;
  }

  state(): VaultState {
    return {
      unlocked: this.database !== undefined,
      expiresAt: null,
      idleExpiresAt: null,
    };
  }

  check(): boolean {
    return this.database !== undefined;
  }

  listEntries(): EntryMeta[] {
    return this.readable()
      .map((entry) => metaOf(entry))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getSshKey(name: string): SshKeyMaterial {
    const entry = findUnique(this.readable(), name);
    if (!entry) throw new HomectlError(2, "No such entry");
    const material = readSshKey(entry);
    this.handed.push(material.privateKey);
    return material;
  }

  getSecret(id: string): Record<string, string> {
    const entry = findById(this.readable(), id);
    if (!entry) throw new HomectlError(2, "No such entry");
    return readFields(entry);
  }

  async elevate(): Promise<never> {
    throw new HomectlError(5, "Unattended session cannot elevate");
  }

  async putSecret(): Promise<never> {
    throw new HomectlError(5, "Unattended session is read-only");
  }

  async removeEntry(): Promise<never> {
    throw new HomectlError(5, "Unattended session is read-only");
  }

  async setTags(): Promise<never> {
    throw new HomectlError(5, "Unattended session is read-only");
  }

  lock(reason: LockReason = "manual"): void {
    if (!this.database) return;
    this.database = undefined;
    for (const buffer of this.handed.splice(0)) buffer.fill(0);
    for (const listener of [...this.listeners]) {
      try {
        listener(reason);
      } catch {
        // A faulty listener must not keep the session unlocked.
      }
    }
  }

  onLock(listener: LockListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Non-admin entries only, filtered now, so a tag added after the restart is honoured.
  private readable() {
    const open = this.database;
    if (!open) throw new HomectlError(5, "Vault is locked");
    return managedEntries(open.db).filter((entry) => !isAdmin(entry));
  }
}
