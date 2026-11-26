// Owner-only server-side restore of a reset client (homelab #21 §6, W5, D6A).
// The server holds each client's wrapped backup key, so it can decrypt that
// client's backups. That is never automatic: preview, restore and delivery all
// need the owner's step-up and a stated reason, and each is audited.
//
// A restore verifies the whole snapshot before anything changes. It then
// retires the source identity (its link and queued work go; its key is kept so
// the history stays restorable) and issues an invite bound to the restore. A
// fresh device that joins with that invite fetches the restorable files, with
// the source's revocations reapplied, writes them, and acknowledges. Only the
// acknowledgment consumes the grant, so a failed delivery can be fetched again
// within the grant window. A device that already holds files declines, and the
// server drops its fresh identity. The plaintext is never stored on the server.
import type { BackupStore, RestoredFile } from "../backup";
import { inspectSnapshot, restoreSnapshot, unwrapCustodyKey } from "../backup";
import { HomectlError } from "../types";
import type { WorkspaceAudit } from "./audit";
import { retireClient, retiredRevocations } from "./retired";
import { applyRevocations } from "./revocations";
import { isRestorable } from "./restore-files";
import {
  backupClientId,
  linked,
  type Revocations,
  type RestoreGrant,
  type ServerState,
  type ServerStateFile,
} from "./state";

// How long a fresh device has to finish joining after the restore is issued.
export const RESTORE_GRANT_MS = 10 * 60_000;
// Restorable state is a few small files; this bounds what one delivery carries.
export const MAX_RESTORE_BYTES = 8 * 1024 * 1024;

export interface RestoreBinding {
  source: string;
  seq: number;
  reason: string;
  issuedAt: number;
  revocations?: Revocations;
}

export interface RestoreDeps {
  file: ServerStateFile;
  store: BackupStore;
  audit: WorkspaceAudit;
  now(): number;
}

export interface RestoreDelivery {
  status: "none" | "restored";
  seq?: number;
  files?: { path: string; data: string }[];
  // What was reapplied or could not be, for the owner to read.
  notes?: string[];
}

export function requireReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length === 0 || reason.length > 300)
    throw new HomectlError(
      3,
      "A restore needs a reason of 1 to 300 characters",
    );
  return reason;
}

// Clients are looked up by own property only (no prototype names).
export function grantFor(binding: RestoreBinding, now: number): RestoreGrant {
  return {
    source: binding.source,
    seq: binding.seq,
    reason: binding.reason,
    issuedAt: binding.issuedAt,
    expiresAt: now + RESTORE_GRANT_MS,
    ...(binding.revocations ? { revocations: binding.revocations } : {}),
  };
}

function wrappedKeyOf(state: ServerState, source: string): string | undefined {
  if (Object.hasOwn(state.clients, source))
    return state.clients[source]?.wrappedBackupKey;
  if (state.retired && Object.hasOwn(state.retired, source))
    return state.retired[source]?.wrappedBackupKey;
  return undefined;
}

// Unwraps the source's backup key under this owner authorization. The caller
// zeroes the returned key.
function keyFor(
  state: ServerState,
  source: string,
  reason: string,
): Uint8Array {
  const wrapped = wrappedKeyOf(state, source);
  if (!wrapped)
    throw new HomectlError(3, "No backup key is held for that client");
  return unwrapCustodyKey(
    wrapped,
    Buffer.from(state.custody, "hex"),
    backupClientId(source),
    { kind: "owner", stepUp: true, reason },
  );
}

function restorableOf(files: RestoredFile[]): RestoredFile[] {
  return files.filter((file) => isRestorable(file.path));
}

export class RestoreService {
  constructor(private readonly deps: RestoreDeps) {}

  // Lists the snapshot's files and sizes. Decrypting the manifest is backup
  // decryption, so it needs the same authority as a restore.
  async preview(input: { source: string; seq?: number; reason: string }) {
    const { source, reason } = input;
    const state = await this.deps.file.read();
    const bid = backupClientId(source);
    const history = await this.deps.store.manifests.list(bid);
    const latest = history.at(-1);
    if (!latest)
      throw new HomectlError(3, "No backups are held for that client");
    const seq = input.seq ?? latest.header.seq;
    const stored = history.find((item) => item.header.seq === seq);
    if (!stored)
      throw new HomectlError(3, `No backup at seq ${seq} for that client`);
    const key = keyFor(state, source, reason);
    const inspection = await inspectSnapshot(
      this.deps.store,
      bid,
      seq,
      key,
      false,
    ).finally(() => key.fill(0));
    await this.deps.audit.append("restore.previewed", {
      client: source,
      seq,
      reason,
      verified: inspection.ok,
    });
    return {
      source,
      seq,
      createdAt: stored.header.createdAt,
      bytes: stored.header.bytes,
      verified: inspection.ok,
      problems: inspection.problems,
      seqs: history.map((item) => item.header.seq),
      files: (inspection.manifest?.files ?? []).map((file) => ({
        path: file.path,
        size: file.size,
        restorable: isRestorable(file.path),
      })),
    };
  }

  // Verifies the snapshot, then retires the source. Returns the binding for the
  // invite the fresh device joins with. Nothing changes if verification fails.
  async issue(input: { source: string; seq: number; reason: string }): Promise<{
    binding: RestoreBinding;
    files: number;
    bytes: number;
  }> {
    const { source, seq, reason } = input;
    const state = await this.deps.file.read();
    const key = keyFor(state, source, reason);
    let files: RestoredFile[];
    try {
      files = await restoreSnapshot(
        this.deps.store,
        backupClientId(source),
        seq,
        { kind: "owner", stepUp: true, reason },
        key,
      );
    } catch (error) {
      await this.deps.audit.append("restore.refused", {
        client: source,
        seq,
        reason,
        outcome: "failed-verification",
      });
      throw error;
    } finally {
      key.fill(0);
    }
    const restorable = restorableOf(files);
    if (restorable.length === 0)
      throw new HomectlError(3, "That snapshot holds no restorable state");
    const bytes = restorable.reduce((sum, file) => sum + file.data.length, 0);
    if (bytes > MAX_RESTORE_BYTES)
      throw new HomectlError(
        3,
        "That snapshot's restorable state is too large for one restore",
      );

    // Retirement: the link and queued work go with the record, its mirror is
    // kept as history, and its wrapped key stays so the history is restorable.
    const { revocations, retired } = await this.deps.file.update((next) => {
      const current = linked(next, source);
      const known = current?.revocations ?? retiredRevocations(next, source);
      if (current) retireClient(next, source, "restore", this.deps.now());
      return { revocations: known, retired: current !== undefined };
    });
    if (retired)
      await this.deps.audit.append("client.revoked", {
        client: source,
        cause: "restore",
      });
    await this.deps.audit.append("restore.issued", {
      client: source,
      seq,
      reason,
      files: restorable.length,
      bytes,
      verified: true,
    });
    return {
      binding: {
        source,
        seq,
        reason,
        issuedAt: this.deps.now(),
        ...(revocations ? { revocations } : {}),
      },
      files: restorable.length,
      bytes,
    };
  }

  // Whether a restore is waiting for this client. Reveals no content.
  async status(
    client: string,
  ): Promise<{ pending: boolean; seq?: number; expiresAt?: number }> {
    const state = await this.deps.file.read();
    const grant = Object.hasOwn(state.clients, client)
      ? state.clients[client]?.restore
      : undefined;
    if (!grant || grant.expiresAt <= this.deps.now()) return { pending: false };
    return { pending: true, seq: grant.seq, expiresAt: grant.expiresAt };
  }

  // Decrypts the restorable files for the client that holds the grant, with
  // the source's revocations reapplied. Nothing is consumed here: the grant
  // ends only when the client acknowledges. A fetch after a lost reply gets the
  // same files again, until the grant expires.
  async deliver(client: string): Promise<RestoreDelivery> {
    const { grant, expired } = await this.deps.file.update((next) => {
      const current = linked(next, client);
      if (!current) throw new HomectlError(3, "Unknown workspace client");
      const taken = current.restore;
      if (!taken) return { grant: undefined, expired: false };
      if (taken.expiresAt > this.deps.now())
        return { grant: taken, expired: false };
      current.restore = undefined;
      return { grant: undefined, expired: true };
    });
    if (expired) {
      await this.deps.audit.append("restore.refused", {
        client,
        outcome: "expired",
      });
      return { status: "none" };
    }
    if (!grant) return { status: "none" };
    try {
      const state = await this.deps.file.read();
      const bid = backupClientId(grant.source);
      const stored = (await this.deps.store.manifests.list(bid)).find(
        (item) => item.header.seq === grant.seq,
      );
      if (!stored)
        throw new HomectlError(
          3,
          "The snapshot for this restore is no longer held",
        );
      const key = keyFor(state, grant.source, grant.reason);
      let files: RestoredFile[];
      try {
        files = await restoreSnapshot(
          this.deps.store,
          bid,
          grant.seq,
          { kind: "owner", stepUp: true, reason: grant.reason },
          key,
        );
      } finally {
        key.fill(0);
      }
      const applied = applyRevocations(
        restorableOf(files),
        grant.revocations,
        stored.header.createdAt,
      );
      const bytes = applied.files.reduce((sum, f) => sum + f.data.length, 0);
      if (bytes > MAX_RESTORE_BYTES)
        throw new HomectlError(3, "The restorable state is too large");
      await this.deps.audit.append("restore.delivered", {
        client,
        source: grant.source,
        seq: grant.seq,
        files: applied.files.length,
      });
      return {
        status: "restored",
        seq: grant.seq,
        files: applied.files.map((file) => ({
          path: file.path,
          data: Buffer.from(file.data).toString("base64"),
        })),
        notes: applied.notes,
      };
    } catch (error) {
      await this.deps.audit.append("restore.refused", {
        client,
        source: grant.source,
        seq: grant.seq,
        outcome: "failed-verification",
      });
      throw error;
    }
  }

  // The client wrote the files and confirms it. Only now does the grant end.
  // Repeating the acknowledgment after that is harmless.
  async acknowledge(
    client: string,
    seq: number,
  ): Promise<{ acknowledged: true }> {
    const ended = await this.deps.file.update((next) => {
      const current = linked(next, client);
      if (!current) throw new HomectlError(3, "Unknown workspace client");
      const taken = current.restore;
      if (!taken) return false;
      if (taken.seq !== seq)
        throw new HomectlError(
          3,
          "That restore is not waiting for this device",
        );
      current.restore = undefined;
      return true;
    });
    if (ended)
      await this.deps.audit.append("restore.acknowledged", { client, seq });
    return { acknowledged: true };
  }

  // The device already holds restorable files, so the restore cannot be
  // applied here. The fresh identity is retired (it holds nothing), and the
  // source stays revoked. The owner issues the restore again.
  async decline(client: string, seq: number): Promise<{ declined: true }> {
    const source = await this.deps.file.update((next) => {
      const current = linked(next, client);
      if (!current?.restore || current.restore.seq !== seq)
        throw new HomectlError(
          3,
          "No restore with that sequence is waiting for this device",
        );
      const grantSource = current.restore.source;
      retireClient(next, client, "declined", this.deps.now());
      return grantSource;
    });
    await this.deps.audit.append("restore.declined", {
      client,
      source,
      seq,
      outcome: "occupied-device",
    });
    return { declined: true };
  }
}
