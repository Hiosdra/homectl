// Control-plane replicator (ADR-0002, stage c). One instance per device.
//
// Each device publishes the signed records it originates (its operations while
// it owns them, its client metadata, its decisions and takeovers) into its own
// hash-chained log, and pulls other devices' logs, relaying them. A pull is
// verified per origin against stored checkpoints before anything is applied.
// The fence decides whether this device may run an operation right now.
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  applyClient,
  applyDecision,
  applyHandoff,
  applyOp,
  type ClientBody,
  consumeDecision,
  type DecisionBody,
  type Envelope,
  emptyReplica,
  establishedEpoch,
  type HandoffBody,
  type OpBody,
  ownerAt,
  type Replica,
  sealRecord,
} from "./replicate";
import type { ClientIdentity } from "./types";

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
}

export interface Pull {
  applied: number;
  blocked: string[];
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
    let data: Persisted;
    try {
      data = JSON.parse(await readFile(path, "utf8")) as Persisted;
    } catch {
      data = {
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
    }
    return new ControlReplicator(
      options.plane,
      options.stateDirectory,
      options.self,
      options.clock ?? Date.now,
      data,
    );
  }

  private async save(): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.data), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, this.path);
  }

  get stateDir(): string {
    return this.stateDirectory;
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
    const replica = this.data.replica;
    if (replica.ops[operationId]) {
      const owner = ownerAt(
        replica,
        operationId,
        establishedEpoch(replica, operationId),
      );
      if (owner === undefined)
        return "Operation owner is not established; conflicting takeovers are waiting for an operator";
      if (owner !== this.self.id)
        return `Operation now belongs to ${this.nameOf(owner)}; it will not run here`;
    }
    const peers = Object.keys(this.data.peers);
    if (peers.length > 0) {
      const lease = leaseCheck(
        peers,
        this.data.syncedAt,
        this.clock(),
        LEASE_MS,
      );
      if (!lease.ok)
        return `Owner lease expired; waiting for sync with ${lease.waitingFor
          .map((id) => this.nameOf(id))
          .join(", ")}`;
    }
    return undefined;
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
  private emit(
    envelope: Envelope<OpBody | ClientBody | DecisionBody | HandoffBody>,
  ): void {
    this.relay(this.self.id, envelope);
    this.apply(envelope);
  }

  private relay(origin: string, envelope: unknown): void {
    const log = this.data.logs[origin] ?? [];
    appendEntry(log, envelope);
    this.data.logs[origin] = log;
  }

  private apply(
    envelope: Envelope<OpBody | ClientBody | DecisionBody | HandoffBody>,
  ): string {
    const replica = this.data.replica;
    const devices = this.devices();
    const body = envelope.body;
    if (body.kind === "op")
      return applyOp(replica, envelope as Envelope<OpBody>, devices);
    if (body.kind === "handoff")
      return applyHandoff(replica, envelope as Envelope<HandoffBody>, devices);
    if (body.kind === "client")
      return applyClient(replica, envelope as Envelope<ClientBody>, devices);
    return applyDecision(replica, envelope as Envelope<DecisionBody>, devices);
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

  // Verifies and applies a pull, origin by origin. Anything that fails the
  // checkpoint check blocks that origin and is recorded, never applied.
  async receive(
    response: ReturnType<ControlReplicator["serve"]>,
    fromPeer: string,
  ): Promise<Pull> {
    const pull: Pull = { applied: 0, blocked: [] };
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
        this.apply(entry.envelope as Envelope<OpBody>);
        pull.applied += 1;
      }
      this.data.checkpoints[origin] = result.checkpoint;
    }
    this.data.seenAt[fromPeer] = this.clock();
    if (pull.blocked.length === 0) this.data.syncedAt[fromPeer] = this.clock();
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
    const registration = this.data.replica.clients[approverId];
    return (
      registration !== undefined &&
      !registration.revoked &&
      registration.scopes.includes("approve:decide") &&
      registration.hosts.includes(host)
    );
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
    const replica = this.data.replica;
    const base = replica.ops[operationId];
    if (!base) throw new HomectlError(2, "Unknown operation");
    const epoch = establishedEpoch(replica, operationId);
    const owner = ownerAt(replica, operationId, epoch);
    if (owner === undefined)
      throw new HomectlError(
        3,
        "Ownership is in conflict; resolve the conflicting takeovers first",
      );
    if (owner === this.self.id)
      throw new HomectlError(2, "This device already owns the operation");
    const window = takeoverWindow(this.data.seenAt[owner], this.clock());
    if (!window.allowed)
      throw new HomectlError(
        3,
        window.at === undefined
          ? `No recent contact with ${this.nameOf(owner)}; takeover is not possible`
          : `Takeover possible after ${new Date(window.at).toISOString()}`,
      );
    if (!(await this.plane.hasHost(base.host)))
      throw new HomectlError(
        3,
        `Host ${base.host} is not in this device's inventory; takeover refused`,
      );
    await this.plane.adoptOperation({
      operationId,
      host: base.host,
      argv: base.argv,
      impact: base.impact,
      issuer: base.issuer,
    });
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
  status(): {
    peers: {
      id: string;
      name: string;
      lastSync?: number;
      lastContact?: number;
      leaseOk: boolean;
    }[];
    blocked: Record<string, string>;
    conflicts: Replica["conflicts"];
  } {
    const peers = Object.keys(this.data.peers);
    const lease = leaseCheck(peers, this.data.syncedAt, this.clock(), LEASE_MS);
    return {
      peers: peers.map((id) => ({
        id,
        name: this.nameOf(id),
        lastSync: this.data.syncedAt[id],
        lastContact: this.data.seenAt[id],
        leaseOk: lease.ok || !lease.waitingFor.includes(id),
      })),
      blocked: { ...this.data.blocked },
      conflicts: [...this.data.replica.conflicts],
    };
  }

  get replica(): Replica {
    return this.data.replica;
  }
}
