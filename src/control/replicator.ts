// Control-plane replicator (ADR-0002, stage c). One instance per device.
//
// Each device publishes the signed records it originates (its operations while
// it owns them, its client metadata, its decisions and takeovers) into its own
// hash-chained log, and pulls other devices' logs, relaying them. A pull is
// verified per origin against stored checkpoints before anything is applied.
// The fence decides whether this device may run an operation right now.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import { canonicalJson, sha256 } from "./canonical";
import {
  appendEntry,
  type Checkpoint,
  checkContinuity,
  type LogEntry,
} from "./checkpoint";
import type { DeviceKey } from "./device-key";
import type { ControlPlane } from "./engine";
import { LEASE_MS, leaseCheck, takeoverWindow } from "./lease";
import { containsSecretMaterial, redactArgv } from "./redact";
import {
  type AcceptBody,
  applyAccept,
  applyCancel,
  applyClient,
  applyDecision,
  applyHandoff,
  applyOffer,
  applyOp,
  applyResolve,
  applyResolveAccept,
  applySuspension,
  type Body,
  type CancelBody,
  type ClientBody,
  consumeDecision,
  type DecisionBody,
  type Envelope,
  emptyReplica,
  establishedEpoch,
  type HandoffBody,
  isAcceptKind,
  OFFER_TTL_MS,
  type OfferBody,
  type OpBody,
  type Outcome,
  offerExpired,
  openConflictFor,
  openOfferFor,
  ownerAt,
  RANK,
  type Replica,
  type ResolveAcceptBody,
  type ResolveBody,
  type SuspensionBody,
  sealRecord,
} from "./replicate";
import type { ClientIdentity, OperationView, TakeoverNote } from "./types";

interface PublishedOp {
  key: string;
  owner: string;
  epoch: number;
  seq: number;
}

interface Persisted {
  version: 1;
  replica: Replica;
  logs: Record<string, LogEntry[]>;
  checkpoints: Record<string, Checkpoint>;
  blocked: Record<string, string>;
  published: {
    ops: Record<string, PublishedOp>;
    clients: Record<string, string>;
  };
  peers: Record<string, { name: string; signingKey?: string }>;
  syncedAt: Record<string, number>;
  seenAt: Record<string, number>;
  // This device, recorded so read-only views can name devices without serve.
  self?: { id: string; name: string };
  // Approvals this device forwarded to an owner, until the owner reflects them.
  forwarded?: Record<string, Forwarded>;
}

interface Forwarded {
  decisionId: string;
  opId: string;
  owner: string;
  approverClient: string;
  decision: "approve" | "reject";
  at: string;
}

export const MAX_FORWARDED = 200;

export const CONFLICT_REASON =
  "Ownership is in conflict; resolve the conflicting takeovers first";

export type ReplicaFile = Persisted;

// Authority of a remote approver, from a replicated registration. Pure: used by
// the CLI fallback that reads replica.json without a running serve.
export function replicatedApproverAuthority(
  data: ReplicaFile,
  approverId: string,
  host: string,
): boolean {
  const registration = data.replica.clients[approverId];
  return (
    registration !== undefined &&
    !registration.revoked &&
    registration.scopes.includes("approve:decide") &&
    registration.hosts.includes(host)
  );
}

export interface Pull {
  applied: number;
  blocked: string[];
}

// The replicated view for one device: notes for operations this device holds,
// and full views for operations it only sees through replication.
export interface ReplicaOverlay {
  notes: Record<
    string,
    Pick<
      OperationView,
      | "ownerName"
      | "runsOn"
      | "conflict"
      | "takeover"
      | "delivery"
      | "approvedBy"
      | "offerTo"
      | "offerFrom"
      | "offerExpires"
    >
  >;
  remote: OperationView[];
}

// Reads the saved replica without a running serve. Read-only: missing or
// unreadable state means nothing has been replicated yet.
export async function loadReplicaFile(
  stateDirectory: string,
): Promise<ReplicaFile | undefined> {
  return (await readPersisted(join(stateDirectory, "replica.json"))) as
    | ReplicaFile
    | undefined;
}

// Missing file: nothing replicated yet. Any other read or parse problem is an
// integrity doubt: refuse, and leave the file untouched so damaged state is
// never replaced silently.
async function readPersisted(path: string): Promise<Persisted | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new HomectlError(
      5,
      "Replica state cannot be read; nothing was changed. Restore replica.json from backup before starting.",
    );
  }
  try {
    const parsed = JSON.parse(text) as Persisted | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.replica === "object" &&
      parsed.replica !== null
    )
      return parsed;
  } catch {
    // Reported below with the same message.
  }
  throw new HomectlError(
    5,
    "Replica state is not valid JSON; nothing was overwritten. Restore replica.json from backup before starting.",
  );
}

// What a device needs to take an operation over: the signed plan facts, including
// the typed catalogue input and the fingerprint the planner computed.
function adoptionInput(operationId: string, base: OpBody) {
  return {
    operationId,
    host: base.host,
    argv: base.argv,
    impact: base.impact,
    issuer: base.issuer,
    catalogueInput: base.catalogueInput,
    fingerprint: base.fingerprint,
  };
}

function deviceName(data: ReplicaFile, id: string): string {
  if (id === data.self?.id) return data.self.name;
  return data.peers[id]?.name ?? id;
}

// Fail closed: the owner must be established, must be this device, must not
// have offered the operation away (until the offer expires), and must hold a
// fresh lease with every paired peer that counts toward this device's lease.
export function fenceOf(
  data: ReplicaFile,
  selfId: string,
  operationId: string,
  now: number,
): string | undefined {
  const replica = data.replica;
  if (replica.ops[operationId]) {
    const owner = ownerAt(
      replica,
      operationId,
      establishedEpoch(replica, operationId),
    );
    if (owner === undefined)
      return "Operation owner is not established; conflicting takeovers are waiting for an operator";
    if (owner !== selfId)
      return `Operation now belongs to ${deviceName(data, owner)}; it will not run here`;
    const offer = openOfferFor(replica, operationId);
    if (offer?.fromOwner === selfId && !offerExpired(offer, now))
      return `Handoff offered to ${deviceName(data, offer.toOwner)}; this device will not run it unless the offer is cancelled`;
  }
  const peers = leasePeers(data, selfId);
  if (peers.length > 0) {
    const lease = leaseCheck(peers, data.syncedAt, now, LEASE_MS);
    if (!lease.ok)
      return `Owner lease expired; waiting for sync with ${lease.waitingFor
        .map((id) => deviceName(data, id))
        .join(", ")}`;
  }
  return undefined;
}

export const LEGACY_REASON =
  "Re-pair this device to enable control sync; it has no signing key";

// The active suspension of `target` by `by`, if any.
export function suspensionOf(
  data: ReplicaFile,
  by: string,
  target: string,
): SuspensionBody | undefined {
  const record = data.replica.suspensions[`${by}|${target}`];
  return record?.active ? record : undefined;
}

// Peers that take part in this device's lease: paired with a signing key and
// not suspended from this device's lease. A legacy peer cannot sign or verify
// records, so it is excluded instead of blocking every execution forever. A
// suspended peer was taken out on purpose (see suspendPeer).
export function leasePeers(data: ReplicaFile, selfId: string): string[] {
  return Object.keys(data.peers).filter(
    (id) =>
      data.peers[id]?.signingKey !== undefined &&
      suspensionOf(data, selfId, id) === undefined,
  );
}

// Reasons are short, printable and never carry secret material.
function cleanReason(text: string | undefined): string {
  const value = Array.from(text ?? "")
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : char;
    })
    .join("")
    .trim()
    .slice(0, 80);
  if (containsSecretMaterial(value))
    throw new HomectlError(2, "Reason must not contain secret material");
  return value || "no reason given";
}

// Whether `owner` can be taken over right now, and when the window opens.
// Shared by the engine's views and by takeover() so both always agree.
export async function takeoverStatusOf(
  data: ReplicaFile,
  base: OpBody,
  owner: string | undefined,
  now: number,
  hostKnown: (host: string) => Promise<boolean>,
): Promise<TakeoverNote> {
  if (owner === undefined) return { possible: false, reason: CONFLICT_REASON };
  const window = takeoverWindow(data.seenAt[owner], now);
  if (!window.allowed)
    return window.at === undefined
      ? {
          possible: false,
          reason: `No recent contact with ${deviceName(data, owner)}; takeover is not possible`,
        }
      : {
          possible: false,
          reason: `Takeover possible after ${new Date(window.at).toISOString()}`,
          at: new Date(window.at).toISOString(),
        };
  if (!(await hostKnown(base.host)))
    return {
      possible: false,
      reason: `Host ${base.host} is not in this device's inventory; add it here before taking over`,
    };
  return { possible: true };
}

// Pure summary of the replica for status views (serve and read-only CLI).
export function summarize(data: ReplicaFile, now: number) {
  const selfId = data.self?.id ?? "";
  const peers = Object.keys(data.peers);
  const lease = leaseCheck(
    leasePeers(data, selfId),
    data.syncedAt,
    now,
    LEASE_MS,
  );
  const replica = data.replica;
  return {
    peers: peers.map((id) => {
      const legacy = data.peers[id]?.signingKey === undefined;
      const suspension = suspensionOf(data, selfId, id);
      return {
        id,
        name: data.peers[id]?.name ?? id,
        // A legacy peer has no control sync, so it has no control "last sync".
        lastSync: legacy ? undefined : data.syncedAt[id],
        lastContact: data.seenAt[id],
        leaseOk:
          legacy || suspension !== undefined
            ? false
            : lease.ok || !lease.waitingFor.includes(id),
        ...(legacy ? { excluded: true, refused: LEGACY_REASON } : {}),
        ...(suspension
          ? {
              suspended: {
                by: deviceName(data, suspension.by),
                at: suspension.at,
                reason: suspension.reason,
              },
            }
          : {}),
      };
    }),
    // Every active suspension, as seen by this device (display only).
    suspensions: Object.values(replica.suspensions)
      .filter((record) => record.active)
      .map((record) => ({
        by: deviceName(data, record.by),
        target: deviceName(data, record.target),
        at: record.at,
        reason: record.reason,
      })),
    blocked: { ...data.blocked },
    // Only conflicts that still leave an operation without an owner.
    conflicts: replica.conflicts
      .filter((c) => openConflictFor(replica, c.opId)?.epoch === c.epoch)
      .map((c) => ({ ...c, candidates: [...c.candidates] })),
    resolutions: Object.values(replica.resolutions)
      .filter(
        (r) =>
          replica.resolutionStatus[r.resolutionId] === "pending" &&
          openConflictFor(replica, r.opId)?.epoch === r.conflictEpoch,
      )
      .map((r) => ({
        resolutionId: r.resolutionId,
        opId: r.opId,
        conflictEpoch: r.conflictEpoch,
        winner: r.winner,
        resolver: r.resolver,
      })),
  };
}

// Device ids to display names, for presentation only.
export function deviceNames(data: ReplicaFile): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [id, peer] of Object.entries(data.peers)) names[id] = peer.name;
  if (data.self) names[data.self.id] = data.self.name;
  return names;
}

// Builds the replicated view for every operation this device does not hold
// locally, and the notes (owner, delivery, takeover) for those it does.
export async function overlayOf(
  data: ReplicaFile,
  selfId: string,
  localIds: Set<string>,
  now: number,
  hostKnown: (host: string) => Promise<boolean>,
): Promise<ReplicaOverlay> {
  const replica = data.replica;
  const overlay: ReplicaOverlay = { notes: {}, remote: [] };
  for (const [opId, base] of Object.entries(replica.ops)) {
    const owner = ownerAt(replica, opId, establishedEpoch(replica, opId));
    const runsOn =
      owner !== undefined && owner !== selfId
        ? deviceName(data, owner)
        : undefined;
    const approval = base.approver;
    const approvedBy =
      approval !== undefined
        ? `${replica.clients[approval]?.name ?? approval} (via ${deviceName(data, replica.clients[approval]?.device ?? "")})`
        : undefined;
    const note: ReplicaOverlay["notes"][string] = {
      ownerName:
        owner === undefined ? "no owner (conflict)" : deviceName(data, owner),
      conflict: owner === undefined,
      ...(runsOn !== undefined ? { runsOn } : {}),
      ...(approvedBy !== undefined ? { approvedBy } : {}),
    };
    if (owner !== selfId)
      note.takeover = await takeoverStatusOf(data, base, owner, now, hostKnown);
    const forwarded = Object.values(data.forwarded ?? {})
      .filter((f) => f.opId === opId)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (forwarded) {
      const confirmed =
        forwarded.decision === "approve"
          ? base.approver === forwarded.approverClient &&
            RANK[base.state] >= RANK.approved
          : base.state === "failed" && base.reason === "rejected";
      note.delivery = {
        decision: forwarded.decision,
        status: confirmed
          ? forwarded.decision === "approve"
            ? "approved"
            : "rejected"
          : "awaiting-confirmation",
        ownerName: deviceName(data, forwarded.owner),
        since: forwarded.at,
      };
    }
    const offer = openOfferFor(replica, opId);
    if (offer?.fromOwner === selfId)
      note.offerTo = deviceName(data, offer.toOwner);
    if (offer?.toOwner === selfId)
      note.offerFrom = deviceName(data, offer.fromOwner);
    if (offer)
      note.offerExpires = new Date(Date.parse(offer.expiresAt)).toISOString();
    overlay.notes[opId] = note;
    if (!localIds.has(opId) && owner !== selfId) {
      overlay.remote.push({
        operationId: opId,
        state: base.state,
        host: base.host,
        classification: base.classification as OperationView["classification"],
        needsApproval: base.needsApproval,
        fingerprint: base.fingerprint,
        argv: redactArgv(base.argv),
        impact: base.impact,
        issuer: base.issuer,
        createdAt: base.updatedAt,
        expiresAt: base.updatedAt,
        updatedAt: base.updatedAt,
        expired: false,
        spawnAttempted: false,
        remote: true,
        ...note,
        ...(base.exitCode !== undefined ? { exitCode: base.exitCode } : {}),
        ...(base.reason !== undefined ? { reason: base.reason } : {}),
      });
    }
  }
  return overlay;
}

export class ControlReplicator {
  private data: Persisted;
  private readonly path: string;

  private constructor(
    private readonly plane: ControlPlane,
    private readonly stateDirectory: string,
    readonly self: { id: string; name: string; key: DeviceKey },
    private readonly clock: () => number,
    data: Persisted,
  ) {
    this.path = join(stateDirectory, "replica.json");
    this.data = data;
  }

  static async open(options: {
    plane: ControlPlane;
    stateDirectory: string;
    self: { id: string; name: string; key: DeviceKey };
    clock?: () => number;
  }): Promise<ControlReplicator> {
    const path = join(options.stateDirectory, "replica.json");
    const loaded = await readPersisted(path);
    const data: Persisted = loaded ?? {
      version: 1,
      replica: emptyReplica(),
      logs: {},
      checkpoints: {},
      blocked: {},
      published: { ops: {}, clients: {} },
      peers: {},
      syncedAt: {},
      seenAt: {},
    };
    data.self = { id: options.self.id, name: options.self.name };
    // Replica files written before handoff offers and resolutions existed.
    data.replica = { ...emptyReplica(), ...data.replica };
    const replicator = new ControlReplicator(
      options.plane,
      options.stateDirectory,
      options.self,
      options.clock ?? Date.now,
      data,
    );
    await replicator.save();
    return replicator;
  }

  private async save(): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.data), {
      mode: 0o600,
      flag: "wx",
    });
    await atomicReplace(temp, this.path);
  }

  get stateDir(): string {
    return this.stateDirectory;
  }

  // Keeps this device's displayed name current after a rename in the panel.
  async refreshSelfName(name: string): Promise<void> {
    if (this.self.name === name && this.data.self?.name === name) return;
    this.self.name = name;
    this.data.self = { id: this.self.id, name };
    await this.save();
  }

  // Pairing hands over the peer's name and signing key (ADR-0002 decision 1).
  async addPeer(id: string, name: string, signingKey?: string): Promise<void> {
    this.data.peers[id] = { name, signingKey };
    await this.save();
  }

  private devices(): Record<string, string> {
    const out: Record<string, string> = {
      [this.self.id]: this.self.key.publicKey,
    };
    for (const [id, peer] of Object.entries(this.data.peers))
      if (peer.signingKey !== undefined) out[id] = peer.signingKey;
    return out;
  }

  removePeer(id: string): void {
    delete this.data.peers[id];
    delete this.data.syncedAt[id];
    delete this.data.seenAt[id];
  }

  peerIds(): string[] {
    return Object.keys(this.data.peers);
  }

  // A peer paired before signing keys existed cannot be verified; control sync
  // refuses it until the device is paired again (fail closed).
  refusalFor(id: string): string | undefined {
    const peer = this.data.peers[id];
    if (!peer) return "Unknown peer";
    return peer.signingKey === undefined
      ? "Re-pair this device to enable control sync; it has no signing key"
      : undefined;
  }

  nameOfPeer(id: string): string {
    return this.nameOf(id);
  }

  private nameOf(id: string): string {
    if (id === this.self.id) return this.self.name;
    return this.data.peers[id]?.name ?? id;
  }

  // The fence (ADR-0002 fencing rule): this device runs an operation only when
  // it is the established owner and holds a fresh lease with every peer.
  fence(operationId: string): string | undefined {
    return fenceOf(this.data, this.self.id, operationId, this.clock());
  }

  // Replicated view for the engine: notes for local operations, full views for
  // operations this device only sees through replication.
  async overlay(localIds: Set<string>): Promise<ReplicaOverlay> {
    return overlayOf(this.data, this.self.id, localIds, this.clock(), (host) =>
      this.plane.hasHost(host),
    );
  }

  // Publishes this device's view of its own operations and clients into its
  // log. Only operations this device currently owns are published.
  async publish(): Promise<number> {
    let emitted = 0;
    const replica = this.data.replica;
    for (const op of await this.plane.listOperations({ all: true })) {
      const id = op.operationId;
      const epoch = replica.ops[id] ? establishedEpoch(replica, id) : 1;
      const owner = replica.ops[id]
        ? ownerAt(replica, id, epoch)
        : this.self.id;
      if (owner !== this.self.id) continue;
      const planner = replica.ops[id]?.planner ?? this.self.id;
      const key = `${op.state}|${op.approval?.approver ?? ""}|${op.exitCode ?? ""}|${op.reason ?? ""}`;
      const prev = this.data.published.ops[id];
      if (
        prev &&
        prev.key === key &&
        prev.owner === owner &&
        prev.epoch === epoch
      )
        continue;
      const seq = prev && prev.epoch === epoch ? prev.seq + 1 : 1;
      const body: OpBody = {
        kind: "op",
        opId: id,
        owner: this.self.id,
        planner,
        epoch,
        seq,
        state: op.state,
        host: op.host,
        argv: op.argv,
        impact: op.impact,
        classification: op.classification,
        needsApproval: op.needsApproval,
        fingerprint: op.fingerprint,
        issuer: op.issuer,
        ...(op.approval ? { approver: op.approval.approver } : {}),
        ...(op.catalogueInput ? { catalogueInput: op.catalogueInput } : {}),
        updatedAt: op.updatedAt,
        ...(op.exitCode !== undefined ? { exitCode: op.exitCode } : {}),
        ...(op.reason !== undefined ? { reason: op.reason } : {}),
      };
      this.emit(sealRecord(this.self, body));
      this.data.published.ops[id] = { key, owner: this.self.id, epoch, seq };
      emitted += 1;
    }
    for (const client of await this.plane.listClients()) {
      const hash = sha256(
        canonicalJson({
          name: client.name,
          scopes: client.scopes,
          hosts: client.hosts,
          revoked: client.revoked,
        }),
      );
      if (this.data.published.clients[client.id] === hash) continue;
      const body: ClientBody = {
        kind: "client",
        clientId: client.id,
        device: this.self.id,
        name: client.name,
        scopes: client.scopes,
        hosts: client.hosts,
        createdAt: client.createdAt,
        revoked: client.revoked,
        ...(client.revoked
          ? { revokedAt: new Date(this.clock()).toISOString() }
          : {}),
      };
      this.emit(sealRecord(this.self, body));
      this.data.published.clients[client.id] = hash;
      emitted += 1;
    }
    await this.save();
    return emitted;
  }

  // Appends a signed envelope to this device's own log and applies it locally.
  private emit(envelope: Envelope<Body>): void {
    this.relay(this.self.id, envelope);
    this.apply(envelope);
  }

  private relay(origin: string, envelope: unknown): void {
    const log = this.data.logs[origin] ?? [];
    appendEntry(log, envelope);
    this.data.logs[origin] = log;
  }

  private apply(envelope: Envelope<Body>): Outcome {
    const replica = this.data.replica;
    const devices = this.devices();
    const body = envelope.body;
    switch (body.kind) {
      case "op":
        return applyOp(replica, envelope as Envelope<OpBody>, devices);
      case "handoff":
        return applyHandoff(
          replica,
          envelope as Envelope<HandoffBody>,
          devices,
        );
      case "client":
        return applyClient(replica, envelope as Envelope<ClientBody>, devices);
      case "offer":
        return applyOffer(replica, envelope as Envelope<OfferBody>, devices);
      case "cancel":
        return applyCancel(replica, envelope as Envelope<CancelBody>, devices);
      case "accept":
        return applyAccept(replica, envelope as Envelope<AcceptBody>, devices);
      case "resolve":
        return applyResolve(
          replica,
          envelope as Envelope<ResolveBody>,
          devices,
        );
      case "suspension":
        return applySuspension(
          replica,
          envelope as Envelope<SuspensionBody>,
          devices,
        );
      case "resolve-accept":
        return applyResolveAccept(
          replica,
          envelope as Envelope<ResolveAcceptBody>,
          devices,
        );
      default:
        return applyDecision(
          replica,
          envelope as Envelope<DecisionBody>,
          devices,
        );
    }
  }

  // What this device has verified per origin, sent with every pull.
  request(): { known: Record<string, Checkpoint> } {
    return { known: structuredClone(this.data.checkpoints) };
  }

  // Serves this device's logs (its own and every origin it has verified),
  // beyond what the requester already has.
  serve(request: { known: Record<string, Checkpoint> }): {
    origins: Record<string, { head: Checkpoint; entries: LogEntry[] }>;
  } {
    const origins: Record<string, { head: Checkpoint; entries: LogEntry[] }> =
      {};
    for (const [origin, log] of Object.entries(this.data.logs)) {
      const last = log.at(-1);
      if (!last) continue;
      const cursor = request.known[origin]?.seq ?? 0;
      origins[origin] = {
        head: { seq: last.seq, hash: last.hash },
        entries: log.filter((e) => e.seq > cursor),
      };
    }
    return { origins };
  }

  // Records can depend on records from another origin in the same pull (a
  // resolution needs its conflict, an accept needs its offer). A rejected record
  // is retried until a pass makes no progress, because the origin's checkpoint
  // moves on and would never send it again.
  private applyAll(batch: Envelope<Body>[]): void {
    // Accepts go last: the records they depend on (a finished operation's
    // snapshot, an offer, a resolution) must be in the replica first.
    let pending = [
      ...batch.filter((e) => !isAcceptKind(e.body.kind)),
      ...batch.filter((e) => isAcceptKind(e.body.kind)),
    ];
    for (let pass = 0; pass < 4 && pending.length > 0; pass++) {
      const retry: Envelope<Body>[] = [];
      for (const envelope of pending)
        if (this.apply(envelope) === "rejected") retry.push(envelope);
      if (retry.length === pending.length) break;
      pending = retry;
    }
  }

  // Verifies and applies a pull, origin by origin. Anything that fails the
  // checkpoint check blocks that origin and is recorded, never applied.
  async receive(
    response: ReturnType<ControlReplicator["serve"]>,
    fromPeer: string,
  ): Promise<Pull> {
    // Bring this device's own finished or running operations into the replica
    // first, so an accept in this pull cannot overtake a local execution.
    await this.publish();
    const pull: Pull = { applied: 0, blocked: [] };
    const collected: Envelope<Body>[] = [];
    for (const [origin, batch] of Object.entries(response.origins)) {
      if (origin === this.self.id) continue;
      if (this.data.blocked[origin]) {
        pull.blocked.push(origin);
        continue;
      }
      const known = this.data.checkpoints[origin];
      // A relay can lag behind the origin, which is not evidence of tampering.
      // Only the origin itself can truncate its own log (checked below).
      if (known && batch.head.seq < known.seq && fromPeer !== origin) continue;
      const result = checkContinuity(known, batch.head, batch.entries);
      if (!result.ok) {
        this.data.blocked[origin] = result.reason;
        pull.blocked.push(origin);
        continue;
      }
      const from = known?.seq ?? 0;
      for (const entry of batch.entries) {
        if (entry.seq <= from) continue;
        this.relay(origin, entry.envelope);
        collected.push(entry.envelope as Envelope<Body>);
        pull.applied += 1;
      }
      this.data.checkpoints[origin] = result.checkpoint;
    }
    this.applyAll(collected);
    this.data.seenAt[fromPeer] = this.clock();
    if (pull.blocked.length === 0) this.data.syncedAt[fromPeer] = this.clock();
    if (pull.blocked.length === 0 && this.isSuspendedBySelf(fromPeer))
      await this.setSuspension(fromPeer, false, "synced", "peer.resumed");
    await this.processInbox();
    await this.save();
    return pull;
  }

  // Pulls from a peer. In production the peer's serve() runs behind the
  // authenticated peer channel; here the call is direct.
  async pullFrom(peerId: string, remote: ControlReplicator): Promise<Pull> {
    return this.receive(remote.serve(this.request()), peerId);
  }

  // Routes a decision from an approver on this device to the operation's owner.
  async decide(
    client: ClientIdentity,
    operationId: string,
    fingerprint: string,
    decision: "approve" | "reject",
  ): Promise<{
    decisionId: string;
    owner: string;
    ownerName: string;
    lastSync?: number;
  }> {
    if (!client.scopes.includes("approve:decide"))
      throw new HomectlError(3, "Client lacks the scope for this operation");
    const replica = this.data.replica;
    const base = replica.ops[operationId];
    if (!base) throw new HomectlError(2, "Unknown operation");
    if (!client.hosts.includes(base.host))
      throw new HomectlError(3, "Operation unavailable");
    const owner = ownerAt(
      replica,
      operationId,
      establishedEpoch(replica, operationId),
    );
    if (owner === undefined || owner === this.self.id)
      throw new HomectlError(3, "Operation has no remote owner to decide");
    const body: DecisionBody = {
      kind: "decision",
      decisionId: randomUUID(),
      opId: operationId,
      targetOwner: owner,
      fingerprint,
      decision,
      approverClient: client.id,
      approverDevice: this.self.id,
      at: new Date(this.clock()).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    // Remembered until the owner's replicated state reflects the decision.
    this.data.forwarded ??= {};
    const forwarded = this.data.forwarded;
    forwarded[body.decisionId] = {
      decisionId: body.decisionId,
      opId: operationId,
      owner,
      approverClient: client.id,
      decision,
      at: body.at,
    };
    const ids = Object.keys(forwarded);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_FORWARDED)))
      delete forwarded[id];
    await this.save();
    return {
      decisionId: body.decisionId,
      owner,
      ownerName: this.nameOf(owner),
      lastSync: this.data.syncedAt[owner],
    };
  }

  // Authority of a remote approver, from the replicated registration. Used by
  // the engine when an approval is executed (ADR-0002 decision 2: revocation
  // propagates, so a revoked approver's approvals stop counting).
  approverAuthorized(approverId: string, host: string): boolean {
    return replicatedApproverAuthority(this.data, approverId, host);
  }

  // Owner side: applies decisions addressed to this device through the normal
  // engine approval path, using the approver's replicated registration.
  async processInbox(): Promise<void> {
    const replica = this.data.replica;
    for (const decision of Object.values(replica.inbox)) {
      if (decision.targetOwner !== this.self.id) continue;
      const local = (await this.plane.listOperations({ all: true })).some(
        (op) => op.operationId === decision.opId,
      );
      if (!local) continue;
      const owner = ownerAt(
        replica,
        decision.opId,
        establishedEpoch(replica, decision.opId),
      );
      const registration = replica.clients[decision.approverClient];
      const valid =
        owner === this.self.id &&
        registration !== undefined &&
        !registration.revoked &&
        registration.device === decision.approverDevice;
      if (valid && registration) {
        try {
          await this.plane.request(
            {
              kind: "client",
              client: {
                id: registration.clientId,
                name: registration.name,
                scopes: registration.scopes as ClientIdentity["scopes"],
                hosts: registration.hosts,
              },
            },
            {
              op: "approve",
              operationId: decision.opId,
              fingerprint: decision.fingerprint,
              decision: decision.decision,
            },
          );
        } catch {
          /* The engine has audited the refusal; the decision is still consumed. */
        }
      }
      consumeDecision(replica, decision.decisionId);
    }
  }

  // Takeover by explicit operator action (ADR-0002 decision 5, fencing rule).
  async takeover(operationId: string, by: string): Promise<void> {
    if (
      RANK[this.data.replica.ops[operationId]?.state ?? "pending"] >=
      RANK.executing
    )
      throw new HomectlError(
        3,
        "This operation already ran or is running; it cannot be taken over",
      );
    const replica = this.data.replica;
    const base = replica.ops[operationId];
    if (!base) throw new HomectlError(2, "Unknown operation");
    const epoch = establishedEpoch(replica, operationId);
    const owner = ownerAt(replica, operationId, epoch);
    if (owner === this.self.id)
      throw new HomectlError(2, "This device already owns the operation");
    if (owner !== undefined && suspensionOf(this.data, owner, this.self.id))
      throw new HomectlError(
        3,
        `${this.nameOf(owner)} has suspended this device; resume it before taking over`,
      );
    const status = await takeoverStatusOf(
      this.data,
      base,
      owner,
      this.clock(),
      (host) => this.plane.hasHost(host),
    );
    if (!status.possible)
      throw new HomectlError(3, status.reason ?? "Takeover is not possible");
    if (owner === undefined) throw new HomectlError(3, CONFLICT_REASON);
    await this.adoptIfAbsent(operationId, base);
    const body: HandoffBody = {
      kind: "handoff",
      opId: operationId,
      fromOwner: owner,
      toOwner: this.self.id,
      epoch: epoch + 1,
      by,
      at: new Date(this.clock()).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    await this.save();
  }

  // Read-only views for CLI and panel.
  // Whether this device has suspended `target` from its own lease.
  isSuspendedBySelf(target: string): boolean {
    return suspensionOf(this.data, this.self.id, target) !== undefined;
  }

  // Takes a paired device out of this device's lease. Operations here may run
  // without that device confirming the latest state, so this is an operator
  // decision, signed and replicated so other devices can see it.
  async suspendPeer(
    nameOrId: string,
    reason?: string,
  ): Promise<{ target: string }> {
    const target = this.deviceId(nameOrId, this.peerIds());
    if (this.isSuspendedBySelf(target))
      throw new HomectlError(2, `${this.nameOf(target)} is already suspended`);
    await this.setSuspension(
      target,
      true,
      cleanReason(reason),
      "peer.suspended",
    );
    return { target };
  }

  // Puts a suspended device back into the lease. Also happens automatically
  // on the next successful control sync with that device.
  async resumePeer(nameOrId: string): Promise<{ target: string }> {
    const target = this.deviceId(nameOrId, this.peerIds());
    if (!this.isSuspendedBySelf(target))
      throw new HomectlError(2, `${this.nameOf(target)} is not suspended`);
    await this.setSuspension(target, false, "manual resume", "peer.resumed");
    return { target };
  }

  private async setSuspension(
    target: string,
    active: boolean,
    reason: string,
    event: "peer.suspended" | "peer.resumed",
  ): Promise<void> {
    const body: SuspensionBody = {
      kind: "suspension",
      by: this.self.id,
      target,
      active,
      reason,
      at: new Date(this.clock()).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    await this.plane.recordReplicated({
      event,
      reason: `device ${target}: ${reason}`,
    });
    await this.save();
  }

  // The device that owns an operation at its established epoch.
  ownerOf(operationId: string): string | undefined {
    const replica = this.data.replica;
    return ownerAt(
      replica,
      operationId,
      establishedEpoch(replica, operationId),
    );
  }

  // Routing for the local operator: what this device may do with a handoff.
  openOfferBy(operationId: string): OfferBody | undefined {
    const offer = openOfferFor(this.data.replica, operationId);
    return offer?.fromOwner === this.self.id ? offer : undefined;
  }

  openOfferTo(operationId: string): OfferBody | undefined {
    const offer = openOfferFor(this.data.replica, operationId);
    return offer?.toOwner === this.self.id ? offer : undefined;
  }

  // A device id, or a unique device name, among the given candidates.
  private deviceId(nameOrId: string, among: string[]): string {
    const matches = among.filter(
      (id) => id === nameOrId || this.nameOf(id) === nameOrId,
    );
    if (matches.length === 0)
      throw new HomectlError(2, `No paired device named ${nameOrId}`);
    if (matches.length > 1)
      throw new HomectlError(
        2,
        `Device name ${nameOrId} is ambiguous; use its id`,
      );
    return matches[0] ?? nameOrId;
  }

  // Step 1 of a cooperative handoff: the current owner offers the operation
  // to a named device. From now on this device refuses to run it.
  async offerHandoff(
    operationId: string,
    toDevice: string,
  ): Promise<{ offerId: string; to: string }> {
    const replica = this.data.replica;
    await this.publish();
    if (!replica.ops[operationId])
      throw new HomectlError(2, "Unknown operation");
    if (this.ownerOf(operationId) !== this.self.id)
      throw new HomectlError(3, "Only the current owner can offer a handoff");
    const existing = openOfferFor(replica, operationId);
    if (
      existing &&
      existing.fromOwner === this.self.id &&
      offerExpired(existing, this.clock())
    )
      await this.cancelOffer(operationId, "expired");
    else if (existing)
      throw new HomectlError(
        3,
        "A handoff is already offered for this operation; cancel it first",
      );
    const to = this.deviceId(toDevice, this.peerIds());
    if (suspensionOf(this.data, this.self.id, to))
      throw new HomectlError(
        3,
        `${this.nameOf(to)} is suspended from this device's lease; resume it before a handoff`,
      );
    const refusal = this.refusalFor(to);
    if (refusal)
      throw new HomectlError(
        3,
        `${this.nameOf(to)} cannot take a handoff: ${refusal}`,
      );
    if (RANK[replica.ops[operationId]?.state ?? "pending"] >= RANK.executing)
      throw new HomectlError(
        3,
        "This operation already ran or is running; it cannot be handed off",
      );
    // An offer never outlives the plan or the approval it depends on.
    const view = await this.plane.showOperation(operationId);
    const now = this.clock();
    const limits = [now + OFFER_TTL_MS, Date.parse(view.expiresAt)];
    if (view.approval) limits.push(Date.parse(view.approval.expiresAt));
    const expiresAt = Math.min(...limits);
    if (expiresAt <= now)
      throw new HomectlError(
        3,
        "The plan or approval has expired; plan the operation again before handing it off",
      );
    const body: OfferBody = {
      kind: "offer",
      offerId: randomUUID(),
      opId: operationId,
      fromOwner: this.self.id,
      toOwner: to,
      epoch: establishedEpoch(replica, operationId) + 1,
      at: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    await this.save();
    await this.plane.recordReplicated({
      event: "handoff.offered",
      operationId,
      host: this.data.replica.ops[operationId]?.host,
      reason: `to ${to}`,
    });
    return { offerId: body.offerId, to };
  }

  // The owner withdraws an offer nobody has accepted.
  async cancelOffer(
    operationId: string,
    reason: "withdrawn" | "expired" = "withdrawn",
  ): Promise<void> {
    const offer = this.openOfferBy(operationId);
    if (!offer)
      throw new HomectlError(
        2,
        "No open handoff offer from this device for that operation",
      );
    const body: CancelBody = {
      reason,
      kind: "cancel",
      offerId: offer.offerId,
      opId: operationId,
      fromOwner: this.self.id,
      at: new Date(this.clock()).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    await this.save();
    await this.plane.recordReplicated({
      event: "handoff.cancelled",
      operationId,
      host: this.data.replica.ops[operationId]?.host,
      reason:
        reason === "expired" ? "offer expired" : "offer withdrawn by owner",
    });
  }

  // Step 2 of a cooperative handoff: the named receiver accepts. It takes the
  // operation as pending, so it needs a fresh approval before it can run.
  async acceptOffer(operationId: string): Promise<void> {
    const replica = this.data.replica;
    const offer = this.openOfferTo(operationId);
    if (!offer)
      throw new HomectlError(2, "No handoff offer waits for this device");
    if (RANK[replica.ops[operationId]?.state ?? "pending"] >= RANK.executing)
      throw new HomectlError(
        3,
        "This operation already ran or is running; the offer cannot be accepted",
      );
    if (offerExpired(offer, this.clock()))
      throw new HomectlError(
        3,
        "The handoff offer expired; ask the owner to offer again",
      );
    if (suspensionOf(this.data, offer.fromOwner, this.self.id))
      throw new HomectlError(
        3,
        `${this.nameOf(offer.fromOwner)} has suspended this device; resume it before accepting a handoff`,
      );
    if (offer.epoch !== establishedEpoch(replica, operationId) + 1)
      throw new HomectlError(
        3,
        "The handoff offer is out of date; ask the owner to offer again",
      );
    const base = replica.ops[operationId];
    if (!base) throw new HomectlError(2, "Unknown operation");
    if (!(await this.plane.hasHost(base.host)))
      throw new HomectlError(
        3,
        `Host ${base.host} is not in this device's inventory; accept refused`,
      );
    await this.adoptIfAbsent(operationId, base);
    const body: AcceptBody = {
      kind: "accept",
      offerId: offer.offerId,
      opId: operationId,
      fromOwner: offer.fromOwner,
      toOwner: this.self.id,
      epoch: offer.epoch,
      at: new Date(this.clock()).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    await this.save();
    await this.plane.recordReplicated({
      event: "handoff.accepted",
      operationId,
      host: base.host,
      reason: `epoch ${offer.epoch}`,
    });
  }

  private async adoptIfAbsent(
    operationId: string,
    base: OpBody,
  ): Promise<void> {
    // Held already (taken back): reset it to pending. Otherwise adopt it.
    if (await this.plane.holdsOperation(operationId)) {
      await this.plane.resetForOwnership(operationId);
      return;
    }
    await this.plane.adoptOperation(adoptionInput(operationId, base));
  }

  // Proposes a winner for an ownership conflict. Any device involved in the
  // conflict may propose; the winner's accept is what takes effect.
  async resolveConflict(
    operationId: string,
    winnerDevice: string,
  ): Promise<{ resolutionId: string; winner: string }> {
    const conflict = openConflictFor(this.data.replica, operationId);
    if (!conflict)
      throw new HomectlError(
        3,
        "No ownership conflict to resolve for that operation",
      );
    if (!conflict.candidates.includes(this.self.id))
      throw new HomectlError(
        3,
        "Only a device involved in the conflict can resolve it",
      );
    const winner = this.deviceId(winnerDevice, conflict.candidates);
    const body: ResolveBody = {
      kind: "resolve",
      resolutionId: randomUUID(),
      opId: operationId,
      conflictEpoch: conflict.epoch,
      winner,
      resolver: this.self.id,
      at: new Date(this.clock()).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    await this.save();
    await this.plane.recordReplicated({
      event: "handoff.resolution-proposed",
      operationId,
      host: this.data.replica.ops[operationId]?.host,
      reason: `winner ${winner}`,
    });
    return { resolutionId: body.resolutionId, winner };
  }

  // The named winner agrees: its accept makes it the owner at the next epoch.
  async acceptResolution(operationId: string): Promise<void> {
    const replica = this.data.replica;
    const proposal = Object.values(replica.resolutions)
      .filter(
        (r) =>
          r.opId === operationId &&
          r.winner === this.self.id &&
          replica.resolutionStatus[r.resolutionId] === "pending",
      )
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (!proposal)
      throw new HomectlError(2, "No resolution waits for this device");
    const est = establishedEpoch(replica, operationId);
    if (est !== proposal.conflictEpoch && est !== proposal.conflictEpoch + 1)
      throw new HomectlError(3, "This resolution is out of date");
    const base = replica.ops[operationId];
    if (!base) throw new HomectlError(2, "Unknown operation");
    if (!(await this.plane.hasHost(base.host)))
      throw new HomectlError(
        3,
        `Host ${base.host} is not in this device's inventory; accept refused`,
      );
    await this.adoptIfAbsent(operationId, base);
    const body: ResolveAcceptBody = {
      kind: "resolve-accept",
      resolutionId: proposal.resolutionId,
      opId: operationId,
      conflictEpoch: proposal.conflictEpoch,
      winner: this.self.id,
      at: new Date(this.clock()).toISOString(),
    };
    this.emit(sealRecord(this.self, body));
    await this.save();
    await this.plane.recordReplicated({
      event: "handoff.resolution-accepted",
      operationId,
      host: base.host,
      reason: `epoch ${proposal.conflictEpoch + 1}`,
    });
  }

  // Whether a resolution naming this device is waiting for its accept.
  resolutionWaitingFor(operationId: string): boolean {
    const replica = this.data.replica;
    return Object.values(replica.resolutions).some(
      (r) =>
        r.opId === operationId &&
        r.winner === this.self.id &&
        replica.resolutionStatus[r.resolutionId] === "pending",
    );
  }

  status(): ReturnType<typeof summarize> {
    return summarize(this.data, this.clock());
  }

  get replica(): Replica {
    return this.data.replica;
  }
}
