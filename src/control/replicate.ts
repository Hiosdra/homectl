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
import type { CatalogueInput, OperationState } from "./types";

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
  // Typed Proxmox catalogue input; the receiving device rebuilds the plan from it.
  catalogueInput?: CatalogueInput;
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

// Cooperative handoff (ADR-0002 stage d): the owner offers, the receiver
// accepts, and the owner may cancel an offer that was not accepted.
export interface OfferBody {
  kind: "offer";
  offerId: string;
  opId: string;
  fromOwner: string; // the current owner; signs the offer
  toOwner: string; // the device the offer names
  epoch: number; // established epoch + 1 when offered
  at: string;
  // Signed expiry: min(at + OFFER_TTL_MS, the operation's plan or approval expiry).
  expiresAt: string;
}

export interface CancelBody {
  kind: "cancel";
  offerId: string;
  opId: string;
  fromOwner: string; // signs the cancel
  at: string;
  reason?: "withdrawn" | "expired";
}

// Handoff offers expire this long after they are made (signed timestamps, so
// every device agrees without comparing clocks).
export const OFFER_TTL_MS = 5 * 60_000;

export function offerExpired(offer: OfferBody, now: number): boolean {
  return now > Date.parse(offer.expiresAt);
}

// Executing or finished: a handoff can no longer start from this state.
export function runningOrFinished(replica: Replica, opId: string): boolean {
  const op = replica.ops[opId];
  return op !== undefined && RANK[op.state] >= RANK.executing;
}

// Accepts go last within a pull: a finished operation's record must land before
// an accept that was signed against the same operation.
export function isAcceptKind(kind: Body["kind"]): boolean {
  return kind === "accept" || kind === "resolve-accept";
}

// Suspension from the lease (ADR-0002 follow-up). Signed by the device that
// suspends `target`. Only the suspending device excludes `target` from its own
// lease; other devices see the record and show it.
export interface SuspensionBody {
  kind: "suspension";
  by: string; // signer: the suspending device
  target: string;
  active: boolean; // false is a resume
  reason: string; // short, no secret material
  at: string;
}

export interface AcceptBody {
  kind: "accept";
  offerId: string;
  opId: string;
  fromOwner: string;
  toOwner: string; // signs the accept
  epoch: number;
  at: string;
}

// Conflict resolution (ADR-0002 stage d): a device involved in a conflict
// proposes a winner; the winner's own accept makes it the owner at epoch + 1.
export interface ResolveBody {
  kind: "resolve";
  resolutionId: string;
  opId: string;
  conflictEpoch: number;
  winner: string;
  resolver: string; // must equal the signer; a candidate of the conflict
  at: string;
}

export interface ResolveAcceptBody {
  kind: "resolve-accept";
  resolutionId: string;
  opId: string;
  conflictEpoch: number;
  winner: string; // must equal the signer
  at: string;
}

export type Body =
  | SuspensionBody
  | OpBody
  | HandoffBody
  | ClientBody
  | DecisionBody
  | OfferBody
  | CancelBody
  | AcceptBody
  | ResolveBody
  | ResolveAcceptBody;

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
  offers: Record<string, OfferBody>;
  offerStatus: Record<string, "open" | "accepted" | "cancelled">;
  resolutions: Record<string, ResolveBody>;
  resolutionStatus: Record<string, "pending" | "accepted">;
  // Latest suspension per "<by>|<target>".
  suspensions: Record<string, SuspensionBody>;
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
    offers: {},
    offerStatus: {},
    resolutions: {},
    resolutionStatus: {},
    suspensions: {},
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
  // A finished operation never goes back to an earlier state, whatever the epoch.
  if (
    RANK[current.state] >= RANK.succeeded &&
    RANK[body.state] < RANK.succeeded
  )
    return "stale";
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
  return recordHandoff(replica, body);
}

// Records an accepted handoff at its epoch. Two different owners at one epoch
// become a conflict with no owner (fail closed).
function recordHandoff(replica: Replica, body: HandoffBody): Outcome {
  if (runningOrFinished(replica, body.opId)) return "rejected";
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

export function applySuspension(
  replica: Replica,
  envelope: Envelope<SuspensionBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "suspension") return "rejected";
  // A device speaks only for itself: the signer must be the suspending device.
  if (envelope.signer !== body.by || body.target === body.by) return "rejected";
  if (typeof body.reason !== "string" || body.reason.length > 80)
    return "rejected";
  const key = `${body.by}|${body.target}`;
  const current = replica.suspensions[key];
  if (current && Date.parse(body.at) < Date.parse(current.at)) return "stale";
  if (current?.active === body.active && current.at === body.at)
    return "duplicate";
  replica.suspensions[key] = body;
  return "applied";
}

// The open offer for an operation, if any. At most one is open at a time.
export function openOfferFor(
  replica: Replica,
  opId: string,
): OfferBody | undefined {
  return Object.values(replica.offers).find(
    (o) => o.opId === opId && replica.offerStatus[o.offerId] === "open",
  );
}

// The conflict that still leaves the operation without an owner, if any.
export function openConflictFor(
  replica: Replica,
  opId: string,
): { opId: string; epoch: number; candidates: string[] } | undefined {
  const epoch = establishedEpoch(replica, opId);
  if (ownerAt(replica, opId, epoch) !== undefined) return undefined;
  return replica.conflicts.find((c) => c.opId === opId && c.epoch === epoch);
}

export function applyOffer(
  replica: Replica,
  envelope: Envelope<OfferBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "offer") return "rejected";
  // Only the current owner offers its operation away.
  if (envelope.signer !== body.fromOwner) return "rejected";
  if (body.toOwner === body.fromOwner) return "rejected";
  if (!replica.ops[body.opId]) return "rejected";
  if (runningOrFinished(replica, body.opId)) return "rejected";
  const lifetime = Date.parse(body.expiresAt) - Date.parse(body.at);
  if (!(lifetime > 0) || lifetime > OFFER_TTL_MS) return "rejected";
  if (replica.offers[body.offerId]) return "duplicate";
  const established = establishedEpoch(replica, body.opId);
  if (ownerAt(replica, body.opId, established) !== body.fromOwner)
    return "rejected";
  if (body.epoch !== established + 1) return "stale";
  if (openOfferFor(replica, body.opId)) return "rejected";
  replica.offers[body.offerId] = body;
  replica.offerStatus[body.offerId] = "open";
  return "applied";
}

export function applyCancel(
  replica: Replica,
  envelope: Envelope<CancelBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "cancel") return "rejected";
  const offer = replica.offers[body.offerId];
  if (!offer || offer.opId !== body.opId) return "rejected";
  if (envelope.signer !== offer.fromOwner || body.fromOwner !== offer.fromOwner)
    return "rejected";
  const status = replica.offerStatus[body.offerId];
  // A cancel wins only over an offer nobody has accepted.
  if (status === "cancelled") return "duplicate";
  if (status !== "open") return "rejected";
  replica.offerStatus[body.offerId] = "cancelled";
  return "applied";
}

export function applyAccept(
  replica: Replica,
  envelope: Envelope<AcceptBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "accept") return "rejected";
  const offer = replica.offers[body.offerId];
  if (!offer || offer.opId !== body.opId) return "rejected";
  // Only the device the offer names can accept it.
  if (envelope.signer !== offer.toOwner) return "rejected";
  if (
    body.toOwner !== offer.toOwner ||
    body.fromOwner !== offer.fromOwner ||
    body.epoch !== offer.epoch
  )
    return "rejected";
  const status = replica.offerStatus[body.offerId];
  // A stale accept after a cancel is rejected: the owner cancelled first.
  if (status === "cancelled") return "rejected";
  // An accept signed after the offer expired is rejected on every device.
  if (Date.parse(body.at) > Date.parse(offer.expiresAt)) return "rejected";
  // An operation that is running or finished cannot change owner.
  if (runningOrFinished(replica, body.opId)) return "rejected";
  if (status === "accepted") return "duplicate";
  if (establishedEpoch(replica, body.opId) !== offer.epoch - 1) return "stale";
  replica.offerStatus[body.offerId] = "accepted";
  return recordHandoff(replica, {
    kind: "handoff",
    opId: body.opId,
    fromOwner: body.fromOwner,
    toOwner: body.toOwner,
    epoch: body.epoch,
    by: "accept",
    at: body.at,
  });
}

// A resolution is valid while the conflict epoch is the established one, or
// the one right after it (a first resolution may already have applied).
function resolutionOpen(replica: Replica, opId: string, epoch: number) {
  const established = establishedEpoch(replica, opId);
  return (
    (established === epoch || established === epoch + 1) &&
    replica.conflicts.some((c) => c.opId === opId && c.epoch === epoch)
  );
}

export function applyResolve(
  replica: Replica,
  envelope: Envelope<ResolveBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "resolve") return "rejected";
  if (envelope.signer !== body.resolver) return "rejected";
  if (!replica.ops[body.opId]) return "rejected";
  if (replica.resolutions[body.resolutionId]) return "duplicate";
  // The conflict may arrive from another origin in the same pull: retry, not stale.
  const conflict = replica.conflicts.find(
    (c) => c.opId === body.opId && c.epoch === body.conflictEpoch,
  );
  if (!conflict) return "rejected";
  if (!resolutionOpen(replica, body.opId, body.conflictEpoch)) return "stale";
  // Only a device involved in the conflict may propose a winner among them.
  if (
    !conflict?.candidates.includes(body.resolver) ||
    !conflict.candidates.includes(body.winner)
  )
    return "rejected";
  replica.resolutions[body.resolutionId] = body;
  replica.resolutionStatus[body.resolutionId] = "pending";
  return "applied";
}

export function applyResolveAccept(
  replica: Replica,
  envelope: Envelope<ResolveAcceptBody>,
  devices: Record<string, string>,
): Outcome {
  const body = openRecord(envelope, devices);
  if (!body || body.kind !== "resolve-accept") return "rejected";
  const proposal = replica.resolutions[body.resolutionId];
  if (!proposal || proposal.opId !== body.opId) return "rejected";
  // The named winner must sign its own accept.
  if (envelope.signer !== proposal.winner || body.winner !== proposal.winner)
    return "rejected";
  if (replica.resolutionStatus[body.resolutionId] === "accepted")
    return "duplicate";
  if (!resolutionOpen(replica, body.opId, proposal.conflictEpoch))
    return "stale";
  replica.resolutionStatus[body.resolutionId] = "accepted";
  return recordHandoff(replica, {
    kind: "handoff",
    opId: body.opId,
    fromOwner: "resolution",
    toOwner: body.winner,
    epoch: proposal.conflictEpoch + 1,
    by: "resolution",
    at: body.at,
  });
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
