// Signed replication records and the state-aware merge for control-plane
// convergence (ADR-0002). Pure logic: no I/O, no clocks, no engine access.
//
// Rules, in short:
// - Every record is signed by the device that originates it. A record whose
//   signer is not the device it claims to speak for is rejected.
// - An operation's state comes only from its current owner. Owner changes need
//   a signed handoff at the next epoch; a second, different handoff at the same
//   epoch is kept as a conflict and the operation has no owner (fail closed).
// - Within an owner epoch, states move only up the lattice
//   pending < approved < executing < terminal, so a replayed "approved" can
//   never reopen an executing or finished operation.
// - Decisions (approve/reject) are signed by the device where the approver
//   client lives; the owner applies each decision id at most once.
// - Client records are signed by the client's device. Revocation is monotone.
import { canonicalJson } from "./canonical";
import { type DeviceKey, signBytes, verifyBytes } from "./device-key";
import type { OperationState } from "./types";

export const RANK: Record<OperationState, number> = {
  pending: 1,
  approved: 2,
  executing: 3,
  succeeded: 4,
  failed: 4,
  unknown: 4,
};

export interface Envelope<T> {
  body: T;
  // Device id of the originator (the peer state id).
  signer: string;
  signature: string;
}

export interface OpBody {
  kind: "op";
  opId: string;
  owner: string; // owner at this epoch
  planner: string; // device that planned the operation; authority for epoch 1
  epoch: number;
  seq: number; // owner-local monotonic sequence for this operation
  state: OperationState;
  host: string;
  argv: string[];
  impact: string;
  classification: string;
  needsApproval: boolean;
  fingerprint: string;
  issuer: string;
  approver?: string;
  updatedAt: string;
  exitCode?: number;
  reason?: string;
}

export interface HandoffBody {
  kind: "handoff";
  opId: string;
  fromOwner: string;
  toOwner: string;
  epoch: number; // must be the operation's current epoch + 1
  by: string; // operator who requested the takeover (informational)
  at: string;
}

export interface ClientBody {
  kind: "client";
  clientId: string;
  device: string; // where the client registration lives
  name: string;
  scopes: string[];
  hosts: string[];
  createdAt: string;
  revoked: boolean;
  revokedAt?: string;
}

export interface DecisionBody {
  kind: "decision";
  decisionId: string;
  opId: string;
  targetOwner: string;
  fingerprint: string;
  decision: "approve" | "reject";
  approverClient: string;
  approverDevice: string; // must equal the signer
  at: string;
}

export type Body = OpBody | HandoffBody | ClientBody | DecisionBody;

export interface Replica {
  version: 1;
  ops: Record<string, OpBody>;
  // Per operation: every accepted handoff, keyed by epoch.
  handoffs: Record<string, Record<number, HandoffBody[]>>;
  clients: Record<string, ClientBody>;
  // Decisions waiting for the owner to apply them, keyed by decision id.
  inbox: Record<string, DecisionBody>;
  seenDecisions: string[];
  conflicts: { opId: string; epoch: number; candidates: string[] }[];
}

export function emptyReplica(): Replica {
  return {
    version: 1,
    ops: {},
    handoffs: {},
    clients: {},
    inbox: {},
    seenDecisions: [],
    conflicts: [],
  };
}

// Signs a body. The signature covers the canonical form of the body only.
export function sealRecord<T extends Body>(
  device: { id: string; key: DeviceKey },
  body: T,
): Envelope<T> {
  return {
    body,
    signer: device.id,
    signature: signBytes(device.key.privateKey, canonicalJson(body)),
  };
}

// Returns the body only if the signer is a known device and the signature
// verifies against that device's registered key.
export function openRecord<T extends Body>(
  envelope: Envelope<T>,
  devices: Record<string, string>,
): T | undefined {
  const publicKey = Object.hasOwn(devices, envelope.signer)
    ? devices[envelope.signer]
    : undefined;
  if (!publicKey) return undefined;
  if (typeof envelope.body !== "object" || envelope.body === null)
    return undefined;
  return verifyBytes(
    publicKey,
    canonicalJson(envelope.body),
    envelope.signature,
  )
    ? envelope.body
    : undefined;
}

// The device that may set states for an operation at a given epoch.
// Undefined means the owner is not established (fail closed).
export function ownerAt(
  replica: Replica,
  opId: string,
  epoch: number,
): string | undefined {
  const base = replica.ops[opId];
  if (!base) return undefined;
  if (epoch <= 1) return base.planner;
  const candidates = replica.handoffs[opId]?.[epoch] ?? [];
  const owners = new Set(candidates.map((h) => h.toOwner));
  return owners.size === 1 ? [...owners][0] : undefined;
}

export type Outcome =
  | "applied"
  | "stale"
  | "rejected"
  | "conflict"
  | "duplicate";

export function applyOp(
  replica: Replica,
  envelope: Envelope<OpBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "op") return "rejected";
  if (envelope.signer !== body.owner) return "rejected";
  const current = replica.ops[body.opId];
  if (!current) {
    // The first snapshot must come from the planning device, at epoch 1.
    if (body.epoch !== 1 || body.owner !== body.planner) return "rejected";
    replica.ops[body.opId] = body;
    return "applied";
  }
  if (body.planner !== current.planner) return "rejected";
  // Anything below the established epoch was superseded by a handoff.
  if (body.epoch < establishedEpoch(replica, body.opId)) return "stale";
  if (body.epoch < current.epoch) return "stale";
  // Only the owner of the snapshot's epoch may set the operation's state.
  if (ownerAt(replica, body.opId, body.epoch) !== body.owner) return "rejected";
  if (body.epoch === current.epoch) {
    if (RANK[body.state] < RANK[current.state]) return "stale";
    if (RANK[body.state] === RANK[current.state] && body.seq <= current.seq)
      return "stale";
  }
  replica.ops[body.opId] = body;
  return "applied";
}

export function applyHandoff(
  replica: Replica,
  envelope: Envelope<HandoffBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "handoff") return "rejected";
  // The taking device signs its own takeover.
  if (envelope.signer !== body.toOwner) return "rejected";
  if (!replica.ops[body.opId]) return "rejected";
  const established = Math.max(
    1,
    ...Object.keys(replica.handoffs[body.opId] ?? {}).map(Number),
  );
  if (body.epoch < 2 || body.epoch > established + 1) return "rejected";
  if (body.epoch < established) return "stale";
  // The takeover must come from the owner of the previous epoch.
  if (ownerAt(replica, body.opId, body.epoch - 1) !== body.fromOwner)
    return "rejected";
  const record = replica.handoffs[body.opId] ?? {};
  const existing = record[body.epoch] ?? [];
  if (existing.some((h) => h.toOwner === body.toOwner)) return "duplicate";
  record[body.epoch] = [...existing, body];
  replica.handoffs[body.opId] = record;
  const owners = new Set(record[body.epoch]?.map((h) => h.toOwner));
  if (owners.size > 1) {
    const candidates = [...owners].sort();
    const known = replica.conflicts.some(
      (c) => c.opId === body.opId && c.epoch === body.epoch,
    );
    if (!known)
      replica.conflicts.push({
        opId: body.opId,
        epoch: body.epoch,
        candidates,
      });
    return "conflict";
  }
  return "applied";
}

export function applyClient(
  replica: Replica,
  envelope: Envelope<ClientBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "client") return "rejected";
  // Only the device that holds the registration may describe it.
  if (envelope.signer !== body.device) return "rejected";
  const current = replica.clients[body.clientId];
  if (current && current.device !== body.device) return "rejected";
  // Revocation is monotone: a revoked client never becomes active again.
  const revoked = body.revoked || current?.revoked === true;
  replica.clients[body.clientId] = {
    ...body,
    revoked,
    revokedAt: current?.revokedAt ?? body.revokedAt,
  };
  return current?.revoked === revoked && current !== undefined
    ? "stale"
    : "applied";
}

export function applyDecision(
  replica: Replica,
  envelope: Envelope<DecisionBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "decision") return "rejected";
  if (envelope.signer !== body.approverDevice) return "rejected";
  if (replica.seenDecisions.includes(body.decisionId)) return "duplicate";
  if (replica.inbox[body.decisionId]) return "duplicate";
  replica.inbox[body.decisionId] = body;
  return "applied";
}

// The owner marks a decision as applied so a replay is never applied twice.
export function consumeDecision(replica: Replica, decisionId: string): void {
  delete replica.inbox[decisionId];
  if (!replica.seenDecisions.includes(decisionId))
    replica.seenDecisions.push(decisionId);
}

// The highest epoch with an accepted handoff (1 when none): older snapshots
// have been superseded and are never applied.
export function establishedEpoch(replica: Replica, opId: string): number {
  return Math.max(1, ...Object.keys(replica.handoffs[opId] ?? {}).map(Number));
}
