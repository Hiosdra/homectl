// Server side of workspace mode (homelab #21 §6). A workspace server keeps the
// mirrored status of linked clients and queues owner decisions for them. It
// never runs anything itself: a client applies an intent only through its own
// engine and its own approval policy. Backups arrive as sealed blobs; the
// server holds only wrapped client keys (D6A custody) and never plaintext.
import { join } from "node:path";
import { BackupStore, LocalBackupServer, unwrapKey, wrapKey } from "../backup";
import { parseHeader } from "../backup/types";
import type { RouteExtension } from "../broker/server";
import type { EventsPort } from "../broker/types";
import { type Envelope, equal } from "../peer/crypto";
import {
  createPair,
  type Identity,
  type Pair,
  pairProof,
  pairStart,
} from "../peer/pairing";
import { HomectlError } from "../types";
import { WorkspaceAudit } from "./audit";
import { ChannelServer } from "./channel";
import { queueDecision } from "./decisions";
import { decidedEvent, type LiveEvent, requestedEvent } from "./live";
import { ChunkQuota } from "./quota";
import {
  grantFor,
  type RestoreBinding,
  RestoreService,
  requireReason,
} from "./restore";
import {
  isRetired,
  retireClient,
  retiredHistory,
  retiredRows,
} from "./retired";
import { clientRows } from "./server-status";
import { applySync, type SyncOutcome } from "./server-sync";
import {
  INTENT_LIST_DEFAULT,
  INTENT_LIST_MAX,
  intentRows,
  pendingRows,
} from "./owner-views";
import {
  backupClientId,
  linked,
  type ServerState,
  type ServerStateFile,
  serverStateFile,
} from "./state";
import * as v from "./validate";

export interface WorkspaceServerOptions {
  now?: () => number;
  backupRoot?: string;
  // Per-client limit on sealed chunk bytes. Defaults to 1 GiB.
  quotaBytes?: number;
  // Where live owner events (approval.requested / approval.decided) go: the
  // server broker's event port. Absent, nothing is pushed; owners poll instead.
  events?: Pick<EventsPort, "emit">;
}

export class WorkspaceServer implements RouteExtension {
  private readonly file: ServerStateFile;
  private readonly store: BackupStore;
  private readonly backups: LocalBackupServer;
  private readonly channel: ChannelServer;
  private readonly quota: ChunkQuota;
  private readonly audit: WorkspaceAudit;
  private readonly restores: RestoreService;
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly events: Pick<EventsPort, "emit"> | undefined;
  private id = "";
  private invite: Pair | undefined;
  // Set with the invite of a restore: the device that pairs with it gets the
  // restored state.
  private restoreBinding: RestoreBinding | undefined;

  constructor(stateDir: string, options: WorkspaceServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.events = options.events;
    this.file = serverStateFile(stateDir);
    this.store = new BackupStore(
      options.backupRoot ?? join(stateDir, "workspace-backups"),
    );
    this.backups = new LocalBackupServer(this.store);
    this.quota = new ChunkQuota(this.store, options.quotaBytes);
    this.audit = new WorkspaceAudit(
      join(stateDir, "workspace-audit.jsonl"),
      this.now,
    );
    this.restores = new RestoreService({
      file: this.file,
      store: this.store,
      audit: this.audit,
      now: this.now,
    });
    this.channel = new ChannelServer(
      () => this.id,
      async (client) => linked(await this.load(), client)?.key,
      (client, action, payload) => this.handle(client, action, payload),
      this.now,
    );
    // Writes the identity on first use: a missing file would otherwise read
    // back as a fresh random identity on every call.
    this.ready = this.file.update((state) => {
      this.id = state.id;
    });
  }

  private async load(): Promise<ServerState> {
    await this.ready;
    return this.file.read();
  }

  // Unauthenticated network paths: pairing and the encrypted channel.
  async network(path: string, body: unknown): Promise<unknown> {
    switch (path) {
      case "/v1/workspace/challenge":
        return this.channel.challenge(v.record(body, "request"));
      case "/v1/workspace/message":
        return this.channel.message(v.record(body, "request"));
      case "/v1/workspace/pair/start": {
        const input = v.record(body, "request");
        return pairStart(this.openInvite(), String(input.public ?? ""));
      }
      case "/v1/workspace/pair/proof":
        return this.pairProof(v.record(body, "request"));
      default:
        return undefined;
    }
  }

  private openInvite(): Pair {
    const invite = this.invite;
    if (!invite || invite.expiresAt <= Date.now()) {
      this.closeInvite();
      throw new HomectlError(
        3,
        "No workspace invite is open; create one on the server",
      );
    }
    return invite;
  }

  private closeInvite(): void {
    this.invite = undefined;
    this.restoreBinding = undefined;
  }

  private async pairProof(body: Record<string, unknown>) {
    const invite = this.openInvite();
    const state = await this.load();
    const local: Identity = {
      id: state.id,
      name: state.name,
      platform: process.platform,
    };
    // A wrong code or proof invalidates the invite inside pairProof.
    const reply = pairProof(
      invite,
      String(body.proof ?? ""),
      body.envelope as Envelope,
      local,
    );
    // One invite admits one client.
    const binding = this.restoreBinding;
    this.closeInvite();
    const remote = invite.remote;
    const key = invite.key;
    if (!remote || !key)
      throw new HomectlError(3, "Pairing attempt unavailable");
    try {
      await this.file.update((next) => {
        if (next.removed.includes(remote.id) || isRetired(next, remote.id))
          throw new HomectlError(3, "This client was removed from this server");
        if (linked(next, remote.id))
          throw new HomectlError(
            3,
            "This client is already linked; remove it first",
          );
        next.clients[remote.id] = {
          name: remote.name,
          platform: remote.platform,
          key: key.toString("hex"),
          joinedAt: this.now(),
          mirror: { lastSeq: 0, events: [] },
          pending: [],
          intents: [],
          ...(binding ? { restore: grantFor(binding, this.now()) } : {}),
        };
      });
    } finally {
      key.fill(0);
    }
    return reply;
  }

  // Authenticated channel actions (client -> server), after the challenge.
  private async handle(
    client: string,
    action: string,
    payload: unknown,
  ): Promise<unknown> {
    const input = v.record(payload, "payload");
    switch (action) {
      case "sync":
        return this.sync(client, input);
      case "backup.key":
        return this.backupKey(client, input);
      case "backup.missing": {
        await this.requireLinked(client);
        return this.backups.missing(
          v.list(input.ids, "ids", v.MAX_MISSING_IDS, (id) =>
            v.hex(id, "chunk id"),
          ),
        );
      }
      case "backup.chunk": {
        await this.requireLinked(client);
        const id = v.hex(input.id, "chunk id");
        const blob = v.blob(input.blob, "chunk");
        const hold = await this.quota.reserve(
          backupClientId(client),
          id,
          blob.length,
        );
        try {
          await this.backups.putChunk(id, blob);
        } catch (error) {
          hold.release();
          throw error;
        }
        return { stored: true };
      }
      case "backup.commit": {
        await this.requireLinked(client);
        const header = parseHeader(input.header);
        if (header.client !== backupClientId(client))
          throw new HomectlError(3, "Backup header belongs to another client");
        return this.backups.commit({
          header,
          sealed: v.text(input.sealed, "sealed manifest", v.MAX_SEALED_CHARS),
        });
      }
      case "restore.status":
        await this.requireLinked(client);
        return this.restores.status(client);
      case "restore.fetch":
        await this.requireLinked(client);
        return this.restores.deliver(client);
      case "restore.ack":
        await this.requireLinked(client);
        return this.restores.acknowledge(
          client,
          v.integer(input.seq, "seq", 1),
        );
      case "restore.decline":
        await this.requireLinked(client);
        return this.restores.decline(client, v.integer(input.seq, "seq", 1));
      default:
        throw new HomectlError(2, "Unknown workspace action");
    }
  }

  private async requireLinked(client: string) {
    if (!linked(await this.load(), client))
      throw new HomectlError(3, "Unknown workspace client");
  }

  private async sync(client: string, input: Record<string, unknown>) {
    const request = v.parseSync(input);
    const now = this.now();
    const outcome = await this.file.update((state) =>
      applySync(state, client, request, now),
    );
    await this.announce(client, outcome);
    return outcome.reply;
  }

  // Pushes what the sync changed. Persisted first, so a failed push never
  // loses state; the owner's poll still shows the item.
  private async announce(client: string, outcome: SyncOutcome): Promise<void> {
    const live: LiveEvent[] = [
      ...outcome.requested.map((item) =>
        requestedEvent({ id: client, name: outcome.name }, item),
      ),
      ...outcome.decided.map((intent) => decidedEvent(client, intent)),
    ];
    for (const event of live)
      await this.events
        ?.emit(event.type, event.subject, event.audience, event.data)
        .catch(() => undefined);
  }

  // Stores the client's backup key wrapped under the custody key, once.
  private async backupKey(client: string, input: Record<string, unknown>) {
    const keyHex = v.hex(input.key, "backup key");
    const bid = backupClientId(client);
    return this.file.update((state) => {
      const current = linked(state, client);
      if (!current) throw new HomectlError(3, "Unknown workspace client");
      const custody = Buffer.from(state.custody, "hex");
      if (current.wrappedBackupKey) {
        const held = Buffer.from(
          unwrapKey(current.wrappedBackupKey, custody, bid),
        ).toString("hex");
        if (!equal(held, keyHex))
          throw new HomectlError(
            3,
            "A different backup key is already registered for this client",
          );
        return { registered: true, created: false };
      }
      current.wrappedBackupKey = wrapKey(
        Buffer.from(keyHex, "hex"),
        custody,
        bid,
      );
      return { registered: true, created: true };
    });
  }

  // Owner routes (/v1/owner/workspace/*). Other paths belong to the client.
  // Decryption routes (preview, restore) need step-up and a reason.
  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    switch (path) {
      case "/v1/owner/workspace/invite":
        await stepUp(input.password);
        return this.createInvite();
      case "/v1/owner/workspace/clients":
        return clientRows(
          await this.load(),
          this.store,
          this.quota,
          this.now(),
        );
      case "/v1/owner/workspace/pending":
        return pendingRows(await this.load(), this.now());
      case "/v1/owner/workspace/intents":
        return this.intents(input);
      case "/v1/owner/workspace/events":
        return this.clientEvents(input);
      case "/v1/owner/workspace/decide":
        return this.decide(input, stepUp);
      case "/v1/owner/workspace/remove":
        await stepUp(input.password);
        return this.remove(input);
      case "/v1/owner/workspace/restore-preview":
        await stepUp(input.password);
        return this.restores.preview({
          source: v.text(input.client, "client", 64),
          seq:
            input.seq === undefined
              ? undefined
              : v.integer(input.seq, "seq", 1),
          reason: requireReason(input.reason),
        });
      case "/v1/owner/workspace/restore":
        await stepUp(input.password);
        return this.restore(input);
      case "/v1/owner/workspace/backup-request":
        return this.requestBackup(input);
      case "/v1/owner/workspace/retired":
        return this.retired(input);
      case "/v1/owner/workspace/server":
        return this.describe();
      default:
        return undefined;
    }
  }

  private async createInvite() {
    const pair = createPair();
    this.invite = pair;
    this.restoreBinding = undefined;
    const state = await this.load();
    return {
      code: pair.code,
      expiresAt: new Date(pair.expiresAt).toISOString(),
      server: { id: state.id, name: state.name },
    };
  }

  // Revokes the source, then opens an invite bound to the restore. The source
  // is revoked only after its snapshot verified.
  private async restore(input: Record<string, unknown>) {
    const source = v.text(input.client, "client", 64);
    const seq = v.integer(input.seq, "seq", 1);
    const reason = requireReason(input.reason);
    const issued = await this.restores.issue({ source, seq, reason });
    const pair = createPair();
    this.invite = pair;
    this.restoreBinding = issued.binding;
    const state = await this.load();
    return {
      code: pair.code,
      expiresAt: new Date(pair.expiresAt).toISOString(),
      restore: { source, seq, files: issued.files, bytes: issued.bytes },
      server: { id: state.id, name: state.name },
    };
  }

  // Asks a client to take a backup on its next sync. Cheap: one flag.
  private async requestBackup(input: Record<string, unknown>) {
    const id = v.text(input.client, "client", 64);
    return this.file.update((state) => {
      const current = linked(state, id);
      if (!current) throw new HomectlError(3, "Unknown workspace client");
      current.backupRequested = true;
      return { client: id, requested: true };
    });
  }

  // Bounded, newest first. Optional client scope; an unknown client is refused.
  private async intents(input: Record<string, unknown>) {
    const state = await this.load();
    const client =
      input.client === undefined
        ? undefined
        : v.text(input.client, "client", 64);
    if (client !== undefined && !linked(state, client))
      throw new HomectlError(3, "Unknown workspace client");
    const limit = Math.min(
      input.limit === undefined
        ? INTENT_LIST_DEFAULT
        : v.integer(input.limit, "limit", 1),
      INTENT_LIST_MAX,
    );
    return intentRows(state, {
      ...(client === undefined ? {} : { client }),
      limit,
    });
  }

  private async clientEvents(input: Record<string, unknown>) {
    const id = v.text(input.client, "client", 64);
    const after =
      input.after === undefined ? 0 : v.integer(input.after, "after");
    const client = linked(await this.load(), id);
    if (!client) throw new HomectlError(3, "Unknown workspace client");
    return client.mirror.events.filter((event) => event.seq > after);
  }

  private async decide(
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ) {
    await this.load();
    return queueDecision(this.file, this.now(), input, stepUp);
  }

  // Unlinks a client and keeps its evidence as retired history. Its wrapped
  // backup key stays, so its history stays restorable.
  private async remove(input: Record<string, unknown>) {
    const id = v.text(input.client, "client", 64);
    return this.file.update((state) => {
      if (!linked(state, id))
        throw new HomectlError(3, "Unknown workspace client");
      retireClient(state, id, "removed", this.now());
      return { removed: id };
    });
  }

  // Read-only: the retired clients, or one client's mirrored history.
  private async retired(input: Record<string, unknown>) {
    const state = await this.load();
    if (input.client === undefined) return retiredRows(state);
    const id = v.text(input.client, "client", 64);
    const history = retiredHistory(state, id);
    if (!history) throw new HomectlError(3, "No retired client with that id");
    return history;
  }

  private async describe() {
    const state = await this.load();
    return {
      id: state.id,
      name: state.name,
      clients: Object.keys(state.clients).length,
    };
  }
}
