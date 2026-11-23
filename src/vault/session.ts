// In-memory vault session: absolute TTL, idle timeout and a shorter privileged
// window. Polling calls (state, check) never extend idle; only touch() does.
import type * as kdbx from "kdbxweb";
import { HomectlError } from "../types";
import type { CredentialSource } from "./credentials";
import * as ops from "./entries";
import { openDatabase, type VaultDatabase } from "./kdbx";
import {
  ADMIN_TAG,
  type EntryMeta,
  type LockReason,
  type SessionOptions,
  type SshKeyMaterial,
  type VaultState,
} from "./types";

type LockListener = (reason: LockReason) => void;

export type SecretValues = Record<string, string>;

export class VaultSession {
  private database: VaultDatabase | undefined;
  private expiresAt = 0;
  private idleExpiresAt = 0;
  private privilegedUntil: number | undefined;
  private opening = false;
  // Bumped by every lock so an unlock or elevate that was in flight cannot land after it.
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly handed: Uint8Array[] = [];
  private readonly listeners = new Set<LockListener>();

  constructor(private readonly options: SessionOptions) {
    for (const value of [
      options.absoluteTtlMs,
      options.idleTtlMs,
      options.privilegedTtlMs,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new HomectlError(
          2,
          "Vault TTLs must be positive whole milliseconds",
        );
  }

  async unlock(path: string, source: CredentialSource): Promise<VaultState> {
    this.check();
    if (this.database || this.opening)
      throw new HomectlError(3, "Vault is already unlocked; lock it first");
    this.opening = true;
    const generation = this.generation;
    let database: VaultDatabase;
    try {
      database = await openDatabase(path, source);
    } finally {
      this.opening = false;
    }
    if (generation !== this.generation)
      throw new HomectlError(5, "Vault unlock cancelled by lock");
    const now = this.options.now();
    this.database = database;
    this.expiresAt = now + this.options.absoluteTtlMs;
    this.idleExpiresAt = now + this.options.idleTtlMs;
    this.privilegedUntil = undefined;
    return this.state();
  }

  // Reports state. Evaluating expiry may lock, but idle is never extended here.
  state(): VaultState {
    this.check();
    if (!this.database)
      return { unlocked: false, expiresAt: null, idleExpiresAt: null };
    const state: VaultState = {
      unlocked: true,
      expiresAt: this.expiresAt,
      idleExpiresAt: Math.min(this.idleExpiresAt, this.expiresAt),
    };
    if (this.privilegedUntil !== undefined)
      state.privilegedUntil = this.privilegedUntil;
    return state;
  }

  // Explicit user or agent activity: resets the idle timer.
  touch(): VaultState {
    this.active();
    this.idleExpiresAt = this.options.now() + this.options.idleTtlMs;
    return this.state();
  }

  // Re-verifies the master password against the file, then opens a privileged
  // window that ends no later than the absolute expiry.
  async elevate(source: CredentialSource): Promise<VaultState> {
    const path = this.active().path;
    const generation = this.generation;
    await openDatabase(path, source);
    if (generation !== this.generation)
      throw new HomectlError(5, "Vault is locked");
    this.active();
    this.privilegedUntil = Math.min(
      this.options.now() + this.options.privilegedTtlMs,
      this.expiresAt,
    );
    return this.state();
  }

  requirePrivileged(): void {
    this.active();
    if (
      this.privilegedUntil === undefined ||
      this.options.now() >= this.privilegedUntil
    ) {
      this.privilegedUntil = undefined;
      throw new HomectlError(
        5,
        "Privileged access required; elevate the vault first",
      );
    }
  }

  // True while unlocked. Locks and returns false when the absolute or idle
  // expiry has passed.
  check(): boolean {
    if (!this.database) return false;
    const now = this.options.now();
    if (now >= this.expiresAt) {
      this.lock("absolute");
      return false;
    }
    if (now >= this.idleExpiresAt) {
      this.lock("idle");
      return false;
    }
    if (this.privilegedUntil !== undefined && now >= this.privilegedUntil)
      this.privilegedUntil = undefined;
    return true;
  }

  // Stops all use and notifies listeners. Key buffers handed out are cleared on
  // a best-effort basis; copies the caller kept are not under our control.
  lock(reason: LockReason = "manual"): void {
    if (!this.database) return;
    this.generation++;
    this.database = undefined;
    this.privilegedUntil = undefined;
    this.expiresAt = 0;
    this.idleExpiresAt = 0;
    for (const buffer of this.handed.splice(0)) buffer.fill(0);
    for (const listener of [...this.listeners]) {
      try {
        listener(reason);
      } catch {
        // A faulty listener must not keep the vault unlocked.
      }
    }
  }

  onLock(listener: LockListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // The open database, for modules that build on the entry API.
  activeDatabase(): VaultDatabase {
    return this.active();
  }

  listEntries(): EntryMeta[] {
    return ops
      .managedEntries(this.active().db)
      .map((entry) => ops.metaOf(entry))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getSshKey(name: string): SshKeyMaterial {
    const entry = ops.findUnique(ops.managedEntries(this.active().db), name);
    if (!entry) throw new HomectlError(2, "No such entry");
    if (ops.isAdmin(entry)) this.requirePrivileged();
    const material = ops.readSshKey(entry);
    this.handed.push(material.privateKey);
    return material;
  }

  getSecret(id: string): Record<string, string> {
    const entry = ops.findById(ops.managedEntries(this.active().db), id);
    if (!entry) throw new HomectlError(2, "No such entry");
    if (ops.isAdmin(entry)) this.requirePrivileged();
    return ops.readFields(entry);
  }

  getField(id: string, name: string): string | undefined {
    const entry = this.lookupById(this.active(), id);
    if (ops.isAdmin(entry)) this.requirePrivileged();
    return ops.text(entry.fields.get(name)) || undefined;
  }

  putSecret(
    name: string,
    values: SecretValues,
    options: { tags?: string[]; group?: string } = {},
  ): Promise<EntryMeta> {
    return this.mutate((database) => {
      const existing = ops.findUnique(ops.managedEntries(database.db), name);
      if (
        (existing && ops.isAdmin(existing)) ||
        options.tags?.includes(ADMIN_TAG) === true
      )
        this.requirePrivileged();
      return ops.metaOf(ops.upsertSecret(database.db, name, values, options));
    });
  }

  removeEntry(id: string): Promise<void> {
    return this.mutate((database) => {
      const entry = this.lookupById(database, id);
      if (ops.isAdmin(entry)) this.requirePrivileged();
      database.db.remove(entry);
    });
  }

  async setTags(id: string, tags: string[]): Promise<EntryMeta> {
    const next = ops.normalizeTags(tags);
    return this.mutate((database) => {
      const entry = this.lookupById(database, id);
      if (ops.isAdmin(entry) || next.includes(ADMIN_TAG))
        this.requirePrivileged();
      entry.tags = next;
      entry.times.update();
      return ops.metaOf(entry);
    });
  }

  // Runs `work` against the open database, then saves atomically. Calls are
  // serialized. `work` must validate before it mutates, because a failed save
  // locks the session rather than keep unsaved changes in memory.
  async mutate<T>(
    work: (database: VaultDatabase) => Promise<T> | T,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const database = this.active();
      const result = await work(database);
      if (this.database !== database)
        throw new HomectlError(5, "Vault is locked");
      try {
        await database.save();
      } catch {
        this.lock("emergency");
        throw new HomectlError(
          5,
          "Vault save failed; session locked so memory and file cannot diverge",
        );
      }
      return result;
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private active(): VaultDatabase {
    const database = this.database;
    if (!database || !this.check())
      throw new HomectlError(5, "Vault is locked");
    return database;
  }

  private lookupById(database: VaultDatabase, id: string): kdbx.KdbxEntry {
    const entry = ops.findById(ops.managedEntries(database.db), id);
    if (!entry) throw new HomectlError(2, "No such entry");
    return entry;
  }
}
