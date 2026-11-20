// Server side of workspace mode (homelab #21 §6). A workspace server keeps the
// mirrored status of linked clients and queues owner decisions for them. It
// never runs anything itself: a client applies an intent only through its own
// engine and its own approval policy. Backups arrive as sealed blobs; the
// server holds only wrapped client keys (D6A custody) and never plaintext.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  BackupStore,
  status as backupStatus,
  LocalBackupServer,
  unwrapKey,
  wrapKey,
} from "../backup";
import { parseHeader } from "../backup/types";
import type { RouteExtension } from "../broker/server";
import { type Envelope, equal } from "../peer/crypto";
import {
  createPair,
  type Identity,
  type Pair,
  pairProof,
  pairStart,
} from "../peer/pairing";
import { HomectlError } from "../types";
import { ChannelServer } from "./channel";
import {
  backupClientId,
  type Intent,
  ingestEvents,
  type LinkedClient,
  type ServerState,
  type ServerStateFile,
  serverStateFile,
} from "./state";
import * as v from "./validate";

const INTENT_MS = 120_000;
const STALE_MS = 60_000;
const MAX_INTENTS = 256;
const KEEP_FINISHED = 128;
const FINISHED = new Set(["applied", "refused"]);

// Client ids are link UUIDs; lookups use own properties only, so a name such
// as "constructor" can never resolve to an object prototype.
function linked(state: ServerState, id: string): LinkedClient | undefined {
  return Object.hasOwn(state.clients, id) ? state.clients[id] : undefined;
}

function publicIntent(intent: Intent) {
  return {
    id: intent.id,
    operationId: intent.operationId,
    fingerprint: intent.fingerprint,
    decision: intent.decision,
    stepUp: intent.stepUp,
    expiresAt: intent.expiresAt,
  };
}

function applyResults(client: LinkedClient, results: v.IntentResult[]) {
  for (const result of results) {
    const intent = client.intents.find((item) => item.id === result.id);
    if (!intent || FINISHED.has(intent.status)) continue;
    intent.status = result.status;
    intent.reason = result.status === "refused" ? result.reason : undefined;
  }
}

function expireIntents(client: LinkedClient, now: number) {
  for (const intent of client.intents)
    if (!FINISHED.has(intent.status) && intent.expiresAt < now) {
      intent.status = "refused";
      intent.reason = "expired";
    }
}

// Keeps the newest finished intents for duplicate checks; open ones are kept.
function pruneIntents(client: LinkedClient) {
  if (client.intents.length <= MAX_INTENTS) return;
  const finished = client.intents
    .filter((item) => FINISHED.has(item.status))
    .slice(-KEEP_FINISHED);
  const keep = new Set(finished);
  client.intents = client.intents.filter(
    (item) => !FINISHED.has(item.status) || keep.has(item),
  );
}

export class WorkspaceServer implements RouteExtension {
  private readonly file: ServerStateFile;
  private readonly store: BackupStore;
  private readonly backups: LocalBackupServer;
  private readonly channel: ChannelServer;
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private id = "";
  private invite: Pair | undefined;

  constructor(
    stateDir: string,
    options: { now?: () => number; backupRoot?: string } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.file = serverStateFile(stateDir);
    this.store = new BackupStore(
      options.backupRoot ?? join(stateDir, "workspace-backups"),
    );
    this.backups = new LocalBackupServer(this.store);
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
      this.invite = undefined;
      throw new HomectlError(
        3,
        "No workspace invite is open; create one on the server",
      );
    }
    return invite;
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
    this.invite = undefined;
    const remote = invite.remote;
    const key = invite.key;
    if (!remote || !key)
      throw new HomectlError(3, "Pairing attempt unavailable");
    try {
      await this.file.update((next) => {
        if (next.removed.includes(remote.id))
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
        await this.backups.putChunk(id, v.blob(input.blob, "chunk"));
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
    return this.file.update((state) => {
      const current = linked(state, client);
      if (!current) throw new HomectlError(3, "Unknown workspace client");
      current.lastSeenAt = now;
      current.remoteApproval = request.status.remoteApproval;
      current.vaultUnlocked = request.status.vaultUnlocked;
      current.pending = request.pending;
      const ingest = ingestEvents(
        current.mirror,
        request.events,
        request.after,
      );
      applyResults(current, request.intentResults);
      expireIntents(current, now);
      if (ingest.gap) return { ack: ingest.lastSeq, gap: true };
      const intents = current.intents.filter(
        (item) => !FINISHED.has(item.status),
      );
      for (const intent of intents)
        if (intent.status === "queued") intent.status = "delivered";
      pruneIntents(current);
      return {
        ack: ingest.lastSeq,
        gap: false,
        intents: intents.map(publicIntent),
      };
    });
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
        return this.clients();
      case "/v1/owner/workspace/pending":
        return this.pending();
      case "/v1/owner/workspace/events":
        return this.events(input);
      case "/v1/owner/workspace/decide":
        return this.decide(input, stepUp);
      case "/v1/owner/workspace/remove":
        await stepUp(input.password);
        return this.remove(input);
      case "/v1/owner/workspace/server":
        return this.describe();
      default:
        return undefined;
    }
  }

  private async createInvite() {
    const pair = createPair();
    this.invite = pair;
    const state = await this.load();
    return {
      code: pair.code,
      expiresAt: new Date(pair.expiresAt).toISOString(),
      server: { id: state.id, name: state.name },
    };
  }

  private async clients() {
    const state = await this.load();
    const now = this.now();
    const out = [];
    for (const [id, client] of Object.entries(state.clients))
      out.push({
        id,
        name: client.name,
        platform: client.platform,
        joinedAt: client.joinedAt,
        lastSeenAt: client.lastSeenAt ?? null,
        stale:
          client.lastSeenAt === undefined || now - client.lastSeenAt > STALE_MS,
        remoteApproval: client.remoteApproval === true,
        vaultUnlocked: client.vaultUnlocked === true,
        pending: client.pending.length,
        mirror: {
          lastSeq: client.mirror.lastSeq,
          gaps: client.mirror.gaps ?? 0,
        },
        backup: await backupStatus(this.store, backupClientId(id)),
      });
    return out;
  }

  private async pending() {
    const state = await this.load();
    const now = this.now();
    return Object.entries(state.clients).flatMap(([id, client]) =>
      client.pending
        .filter((item) => item.expiresAt > now)
        .map((item) => ({ origin: id, originName: client.name, ...item })),
    );
  }

  private async events(input: Record<string, unknown>) {
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
    const id = v.text(input.client, "client", 64);
    const operationId = v.text(input.operationId, "operation id", 128);
    const fingerprint = v.text(input.fingerprint, "fingerprint", 256);
    const decision = input.decision;
    if (decision !== "approve-once" && decision !== "deny-once")
      throw new HomectlError(2, "Unknown decision");
    const client = linked(await this.load(), id);
    if (!client) throw new HomectlError(3, "Unknown workspace client");
    if (client.remoteApproval !== true)
      throw new HomectlError(
        3,
        "This client does not accept approvals from this server",
      );
    const now = this.now();
    const op = client.pending.find(
      (item) =>
        item.id === operationId &&
        item.fingerprint === fingerprint &&
        item.expiresAt > now,
    );
    if (!op)
      throw new HomectlError(
        3,
        "That operation is not waiting for approval with this fingerprint",
      );
    // Step-up is proof of the owner's presence on the origin device. A
    // server's own re-authentication does not stand in for it.
    if (decision === "approve-once" && op.stepUp)
      throw new HomectlError(
        3,
        "This operation needs step-up; approve it on its own device",
      );
    const passwordGiven = input.password !== undefined;
    if (passwordGiven) await stepUp(input.password);
    const intent: Intent = {
      id: randomUUID(),
      operationId,
      fingerprint,
      decision,
      stepUp: false,
      createdAt: now,
      expiresAt: Math.min(now + INTENT_MS, op.expiresAt),
      status: "queued",
    };
    return this.file.update((state) => {
      const current = linked(state, id);
      if (!current) throw new HomectlError(3, "Unknown workspace client");
      if (
        current.intents.some(
          (item) =>
            item.operationId === operationId && item.status !== "refused",
        )
      )
        throw new HomectlError(
          3,
          "This operation already has a decision on its way",
        );
      current.intents.push(intent);
      return intent;
    });
  }

  private async remove(input: Record<string, unknown>) {
    const id = v.text(input.client, "client", 64);
    return this.file.update((state) => {
      if (!linked(state, id))
        throw new HomectlError(3, "Unknown workspace client");
      delete state.clients[id];
      if (!state.removed.includes(id)) state.removed.push(id);
      return { removed: id };
    });
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
