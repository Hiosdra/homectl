// Shared 0.3.0 contracts (Hiosdra/homelab#21). Types and tiny pure helpers
// only: no I/O, no imports from feature modules. Every 0.3.0 module (broker,
// policy, approvals, secrets, events, backup, host permissions, vault) speaks
// these shapes so they compose without adapters.
//
// Change rules: additive changes are fine; renaming or narrowing a field needs
// every importer updated in the same PR.

// ---------------------------------------------------------------- identity

// Client ids follow the existing control-plane pattern.
export const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
// The verified human owner. Never a client id; never usable by agents.
export const OWNER = "owner" as const;

// A device is one homectl installation (client, or the server instance).
export interface DeviceRef {
  id: string; // stable random id, 16+ base64url chars
  name: string;
}

// ---------------------------------------------------------------- risk

// R0 metadata reads, R1 safe inspection, R2 routine reversible change,
// R3 significant / opaque / privileged, R4 destructive, trust or authority
// change, credential export. R3 and R4 always need a human with step-up
// unless an explicit owner rule covers R3 (R4 never).
export const RISKS = ["R0", "R1", "R2", "R3", "R4"] as const;
export type Risk = (typeof RISKS)[number];
export const RISK_POINTS: Record<Risk, number> = {
  R0: 0,
  R1: 1,
  R2: 3,
  R3: 10,
  R4: 30,
};
export function riskAtLeast(value: Risk, floor: Risk): boolean {
  return RISKS.indexOf(value) >= RISKS.indexOf(floor);
}
export function maxRisk(a: Risk, b: Risk): Risk {
  return riskAtLeast(a, b) ? a : b;
}

// ---------------------------------------------------------------- actions

export const ACTION_KINDS = [
  "exec", // argv on an inventory host
  "proxmox", // typed Proxmox catalogue action
  "secret.request", // ask the owner for a secret
  "secret.use", // inject a stored/ephemeral secret into a validated destination
  "secret.raw", // hand a secret value to the agent (exceptional fallback)
  "host.enroll", // add a host / trust its fingerprint
  "host.grant", // expand host-level authority (sudoers drop-in, account)
  "host.revoke", // remove homectl-owned authority
  "app.deploy", // new application deployment (#6): always fresh approval
  "backup.restore",
  "backup.decrypt",
  "policy.change",
  "credential.export",
  "trust.change", // pairing, device trust, server enrolment
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

// Kinds that are never auto-allowed by rules, presets or reviewers.
export const HUMAN_ONLY_KINDS: readonly ActionKind[] = [
  "secret.raw",
  "host.enroll",
  "host.grant",
  "app.deploy",
  "backup.restore",
  "backup.decrypt",
  "policy.change",
  "credential.export",
  "trust.change",
];

export type Classification = "inspect" | "mutation" | "destructive" | "opaque";

// What the engine evaluates. Built by the broker from validated input; the
// `narrative` is requester text and is untrusted (display only).
export interface ActionRequest {
  client: string;
  task?: string;
  kind: ActionKind;
  host?: string;
  argv?: string[];
  sudo?: boolean;
  classification?: Classification;
  // Kind-specific resource id, e.g. "vm:105", "secret:<id>", "rule:<id>".
  resource?: string;
  parameters?: Record<string, string | number | boolean>;
  risk: Risk;
  narrative?: string;
}

// ---------------------------------------------------------------- policy

export type Verdict = "allow" | "deny" | "ask";
export type DecisionSource =
  | "invariant" // fixed security rule (malformed, unknown host, forbidden)
  | "hard-gate" // human-only kind or risk; cannot be waived
  | "rule" // owner rule
  | "budget" // task / aggregate budget exhausted
  | "mode" // Manual mode, or Rules-only with no matching rule
  | "reviewer" // optional model judge
  | "default"; // fallback when nothing else decided

export interface PolicyDecision {
  verdict: Verdict;
  source: DecisionSource;
  ruleId?: string;
  // Fixed, user-readable reason. Never echoes untrusted narrative.
  reason: string;
  // The ask must go to the verified owner; a reviewer may not resolve it.
  humanOnly: boolean;
  // The owner must re-authenticate (passkey or vault password) to approve.
  stepUp: boolean;
  // Number of reviewer (model) calls made for this decision.
  modelCalls: number;
  // Policy revision the decision was made under (bound into approvals).
  policyRevision: number;
  // Optional narrowly scoped rule the owner may accept later (never installed
  // automatically).
  suggestion?: RuleSuggestion;
}

export interface RuleMatch {
  clients?: string[];
  hosts?: string[];
  kinds?: ActionKind[];
  // Each entry is an exact argv prefix; ["systemctl","status"] matches
  // systemctl status <anything>. Empty list = no argv constraint.
  argvPrefixes?: string[][];
  // Each entry is a complete argv; the request must equal one of them.
  // Remembered and reviewer-suggested rules use this, never prefixes.
  // Empty list fails closed.
  argvExact?: string[][];
  classifications?: Classification[];
  resources?: string[];
  // Rule applies only up to this risk (inclusive).
  maxRisk?: Risk;
  sudo?: boolean;
}

export interface RuleLimits {
  expiresAt?: number; // epoch ms
  maxUses?: number;
  // Local wall-clock window, "HH:MM" 24h.
  window?: { start: string; end: string };
}

export interface Rule {
  id: string;
  effect: Verdict;
  match: RuleMatch;
  limits?: RuleLimits;
  // Natural-language residual the reviewer may judge; never widens `match`.
  semantic?: string;
  note?: string;
  createdAt: number;
  // Owner-created only. Suggestions become rules only through the owner.
  createdBy: typeof OWNER;
  uses?: number;
}

export interface RuleSuggestion {
  effect: Verdict;
  match: RuleMatch;
  limits?: RuleLimits;
  reason: string;
}

export type PolicyMode = "manual" | "rules" | "auto";
// What the optional reviewer may resolve on its own (A1).
export type ReviewerAuthority = "recommend" | "routine" | "delegated";

export interface Budgets {
  // Per task.
  taskMaxOperations: number;
  taskMaxRiskPoints: number;
  // Per client, rolling window.
  clientWindowMs: number;
  clientMaxRiskPoints: number;
}

export interface PolicyDocument {
  version: 1;
  revision: number; // monotonically increasing
  mode: PolicyMode;
  reviewer: {
    authority: ReviewerAuthority;
    fallback: "ask" | "deny";
    // Highest risk the reviewer may allow in "routine"/"delegated" authority.
    maxRisk: Risk;
    provider?: string; // adapter id; absent = no reviewer
  };
  rules: Rule[];
  budgets: Budgets;
}

// ---------------------------------------------------------------- tasks

export type TaskState = "open" | "closed" | "expired";
export interface TaskRecord {
  id: string;
  client: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  state: TaskState;
  // Explicitly delegated scope for the task (optional, owner-approved).
  scope?: RuleMatch;
  used: { operations: number; riskPoints: number };
  operations: string[];
}

// ---------------------------------------------------------------- approvals

// Owner decision bound to one exact plan. Signed by the broker's approval key
// after the owner authenticated; consumed exactly once at dispatch.
export interface ApprovalGrant {
  v: 1;
  id: string;
  operationId: string;
  fingerprint: string; // canonical plan fingerprint
  client: string; // issuer of the plan
  host?: string;
  policyRevision: number;
  nonce: string; // 16+ random bytes, base64url
  issuedAt: number;
  expiresAt: number;
  approver: { kind: typeof OWNER; device: string; surface: string };
  stepUp: boolean;
  // Remember-rule created together with this approval, if any.
  ruleId?: string;
  signature: string; // base64 Ed25519 over canonical JSON without `signature`
}

export type DecisionKind =
  | "approve-once"
  | "approve-remember"
  | "deny-once"
  | "deny-remember"
  | "revise";

// ---------------------------------------------------------------- secrets

export type SecretFieldKind = "password" | "token" | "text" | "ssh-key";
export interface SecretField {
  name: string; // [a-z][a-z0-9_]{0,31}
  label: string;
  kind: SecretFieldKind;
}

// Where a secret may go. The broker validates the destination before use and
// never lets the agent choose a different one afterwards.
export type SecretDestination =
  | { kind: "ssh-stdin"; host: string; argv: string[] }
  | { kind: "http-header"; url: string; header: string }
  | { kind: "target-file"; host: string; path: string; mode: string }
  | { kind: "vault-only" };

export type SecretRequestState =
  | "pending"
  | "provided"
  | "declined"
  | "cancelled"
  | "expired"
  | "revoked";

export interface SecretRequestView {
  id: string;
  client: string;
  task?: string;
  purpose: string; // requester text, display only
  destination: SecretDestination;
  fields: SecretField[];
  state: SecretRequestState;
  createdAt: number;
  expiresAt: number; // request expiry (unanswered)
  retention?: "ephemeral" | "saved";
  // Opaque, non-bearer reference. Knowing it grants nothing by itself.
  ref?: string;
}

// ---------------------------------------------------------------- events

export const EVENT_TYPES = [
  "approval.requested",
  "approval.decided",
  "operation.updated",
  "task.updated",
  "secret.requested",
  "secret.resolved",
  "backup.updated",
  "settings.updated",
  "device.updated",
  "vault.locked",
  "vault.unlocked",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// Envelope for the live stream and catch-up. `seq` is per origin device and
// strictly increasing by 1; consumers detect gaps and request catch-up.
export interface EventEnvelope<T = unknown> {
  id: string; // `${origin}:${seq}`
  origin: string; // device id
  seq: number;
  at: number;
  type: EventType;
  subject: string; // operation / task / request id
  // Which clients may see it; [] = owner surfaces only.
  audience: string[];
  data: T; // already redacted; never secret values
}

// ---------------------------------------------------------------- errors

// Exit codes kept from 0.2: 2 usage/validation, 3 policy refusal,
// 4 approval needed, 5 environment/state failure.
export type ExitCode = 2 | 3 | 4 | 5;
