// homectl control-plane API v1 (slice 1). Mirrors schema/control-plane.schema.json.
// Keep the two in sync; tests/control-schema.test.ts checks the enumerations.
import type { Machine } from "../types";

export const CONTROL_API_VERSION = "homectl.control/v1" as const;

export const SCOPES = [
  "status:read",
  "inspect:read",
  "plan:create",
  "approve:decide",
] as const;
export type Scope = (typeof SCOPES)[number];

export const OPERATION_KINDS = [
  "inspect",
  "plan",
  "validate",
  "approve",
  "execute",
  "verify",
  "status",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATES = [
  "pending",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const TERMINAL_STATES: readonly OperationState[] = [
  "succeeded",
  "failed",
  "unknown",
];

export const CLASSIFICATIONS = [
  "inspect",
  "mutation",
  "destructive",
  "opaque",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

// Identity of an authenticated client. Never contains token material.
export interface ClientIdentity {
  id: string;
  name: string;
  scopes: Scope[];
  hosts: string[];
}

// Who is calling. Clients come only from token authentication; the local
// operator is the private CLI on the homectl host.
export type Actor =
  | { kind: "client"; client: ClientIdentity }
  | { kind: "local-operator" };

// Typed operation request. Validated against the schema before dispatch.
export type OperationRequest =
  | { op: "inspect"; host?: string }
  | { op: "status"; operationId?: string }
  | {
      op: "plan";
      host: string;
      argv: string[];
      impact?: string;
      idempotencyKey?: string;
    }
  | { op: "validate"; operationId: string; fingerprint: string }
  | {
      op: "approve";
      operationId: string;
      fingerprint: string;
      decision: "approve" | "reject";
    }
  | { op: "execute"; operationId: string }
  | { op: "verify"; operationId: string };

// Immutable plan snapshot. Hashed with canonical JSON to produce the
// operation fingerprint. `execApproval` is the existing policy digest.
export interface ExecPlan {
  apiVersion: typeof CONTROL_API_VERSION;
  kind: "exec";
  host: string;
  machine: Machine;
  argv: string[];
  impact: string;
  classification: Classification;
  needsApproval: boolean;
  execApproval: string;
}

export interface ApprovalRecord {
  apiVersion: typeof CONTROL_API_VERSION;
  id: string;
  operationId: string;
  fingerprint: string;
  issuer: string;
  approver: string;
  issuedAt: number;
  expiresAt: number;
  // Single-use replay token. Stored only; never returned to clients.
  nonce: string;
  state: "active" | "consumed";
  consumedAt?: number;
}

export interface OperationRecord {
  apiVersion: typeof CONTROL_API_VERSION;
  id: string;
  state: OperationState;
  plan: ExecPlan;
  fingerprint: string;
  issuer: string;
  idempotencyKey?: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  approval?: ApprovalRecord;
  // True once the runner may have started a process. Set before spawn is
  // attempted, so `unknown` is the conservative outcome when unsure.
  spawnAttempted: boolean;
  exitCode?: number;
  // Fixed reason codes from the engine; never free text from clients.
  reason?: string;
}

export interface ApprovalView {
  id: string;
  operationId: string;
  fingerprint: string;
  issuer: string;
  approver: string;
  issuedAt: number;
  expiresAt: number;
  state: "active" | "consumed";
}

// What clients see. Argv is redacted; machine addresses and key paths are not
// included.
export interface OperationView {
  operationId: string;
  state: OperationState;
  host: string;
  classification: Classification;
  needsApproval: boolean;
  fingerprint: string;
  argv: string[];
  impact: string;
  issuer: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  expired: boolean;
  approval?: ApprovalView;
  spawnAttempted: boolean;
  exitCode?: number;
  reason?: string;
}

export interface ClientView {
  id: string;
  name: string;
  scopes: Scope[];
  hosts: string[];
  createdAt: number;
  revoked: boolean;
}

export type AuditEventName =
  | "auth.rejected"
  | "request.accepted"
  | "request.rejected"
  | "client.created"
  | "client.revoked"
  | "operation.planned"
  | "operation.decided"
  | "operation.executing"
  | "operation.succeeded"
  | "operation.failed"
  | "operation.unknown";

// Audit payloads carry identifiers, fixed reason codes and redacted argv only.
export interface AuditEvent {
  event: AuditEventName;
  client?: string;
  op?: OperationKind;
  operationId?: string;
  host?: string;
  argv?: string[];
  fingerprint?: string;
  classification?: Classification;
  decision?: "approve" | "reject";
  reason?: string;
  exitCode?: number;
}

export interface AuditEntry {
  v: 1;
  seq: number;
  at: string;
  prev: string;
  hash: string;
  event: AuditEvent;
}

// Stored client registry record. `tokenHash` is the only credential material.
export interface ClientRecord extends ClientIdentity {
  tokenHash: string;
  createdAt: number;
  revokedAt?: number;
}

// Authentication boundary. Slice 1 implements token-based authentication;
// an OIDC implementation can satisfy this interface later without changing
// the engine or MCP layer.
export interface ClientAuthenticator {
  authenticate(credential: string | undefined): Promise<ClientIdentity | null>;
}
