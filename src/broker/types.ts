// Broker engine types (homelab #21 §4, §7). The broker is the single engine
// behind CLI, MCP and panel: every route calls the same methods, so checks,
// bounds and redaction cannot differ between surfaces.
import type { AgentVerification } from "../core/verification";
import type {
  ActionRequest,
  ApprovalGrant,
  Classification,
  DecisionKind,
  EventType,
  PolicyDecision,
  Risk,
  TaskRecord,
} from "../core/contracts";
import type { Machine, ProcessResult, ProviderConfig } from "../types";
import type { ProxmoxPort } from "./proxmox-exec";
import type { ProxmoxOperationRequest } from "./proxmox-plan";
import type { SetupOperation, SetupRequestKind } from "./setup-request";

export const OPERATION_STATES = [
  "awaiting-approval",
  "denied",
  "dispatching",
  "succeeded",
  "failed",
  "unknown",
  "expired",
  "cancelled",
] as const;
export type BrokerOperationState = (typeof OPERATION_STATES)[number];
export const FINAL_STATES: readonly BrokerOperationState[] = [
  "denied",
  "succeeded",
  "failed",
  "unknown",
  "expired",
  "cancelled",
];

// Output returned to the agent is bounded.
export const OUTPUT_LIMIT = 256 * 1024;

export interface BoundedOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface BrokerOperation {
  id: string;
  client: string;
  task?: string;
  host: string;
  argv: string[];
  impact: string;
  classification: Classification;
  sudo: boolean;
  risk: Risk;
  // Hash of the machine policy at plan time: an inventory change invalidates
  // the plan and any approval for it.
  machineHash: string;
  fingerprint: string;
  decision: Pick<
    PolicyDecision,
    | "verdict"
    | "source"
    | "reason"
    | "stepUp"
    | "humanOnly"
    | "policyRevision"
    | "ruleId"
  > & {
    // Reviewer (model) calls made for this decision; absent on older records.
    modelCalls?: number;
  };
  state: BrokerOperationState;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  // Requester narrative; untrusted, shown to the owner as such.
  narrative?: string;
  grantId?: string;
  approvedBy?: { surface: string; stepUp: boolean; at: number };
  rememberedRule?: string;
  startedAt?: number;
  finishedAt?: number;
  result?: BoundedOutput;
  // Agent-reported check of the outcome. Separate from the exit status and
  // never set by the broker (see core/verification.ts).
  verification?: AgentVerification;
  // Fixed reason codes only.
  reason?: string;
  // Proxmox requests: the typed request (an API call or a catalogue action),
  // the provider's fingerprint at plan time, whether only the owner may
  // approve it, and its plain-language area. argv above is display only.
  proxmox?: ProxmoxOperationRequest;
  providerHash?: string;
  ownerOnly?: boolean;
  area?: string;
  // Setup requests (see setup-request.ts): the validated request, the key the
  // machine presented, and the fingerprint the owner typed to confirm it.
  setup?: SetupOperation;
}

export interface PresentedKey {
  type: string;
  fingerprint: string;
}

export interface SetupRun {
  kind: SetupRequestKind;
  input: Record<string, unknown>;
  // Enrolment only: the fingerprint the owner typed, checked again by the route.
  confirmFingerprint?: string;
}

// The owner's setup routes, as the broker reaches them. presentedKeys and keyReady
// only read; run executes one approved request and nothing else.
export interface SetupPort {
  presentedKeys(address: string, port: number): Promise<PresentedKey[]>;
  keyReady(name: string): Promise<boolean>;
  run(request: SetupRun): Promise<ProcessResult>;
}

export interface BrokerState {
  version: 1;
  operations: Record<string, BrokerOperation>;
  tasks: Record<string, TaskRecord>;
}

// What agents see. Same shape for CLI JSON and MCP.
export interface OperationView {
  id: string;
  state: BrokerOperationState;
  host: string;
  argv: string[];
  classification: Classification;
  risk: Risk;
  task?: string;
  fingerprint: string;
  decision: { verdict: string; source: string; reason: string };
  createdAt: string;
  expiresAt: string;
  finishedAt?: string;
  result?: BoundedOutput;
  verification?: AgentVerification;
  reason?: string;
  // Present while awaiting approval: where the owner approves.
  approvalSurface?: string;
}

// ------------------------------------------------------------------ ports

export interface PolicyContext {
  task?: TaskRecord;
  clientRiskPoints: number;
  knownHost: boolean;
  now: number;
}
export interface PolicyPort {
  evaluate(req: ActionRequest, ctx: PolicyContext): Promise<PolicyDecision>;
  revision(): Promise<number>;
  // Rolling window for the per-client risk budget.
  budgetWindowMs?(): Promise<number>;
  // Install an owner-reviewed narrow rule from a decision. Returns rule id.
  remember?(req: ActionRequest, effect: "allow" | "deny"): Promise<string>;
}

export interface InventoryPort {
  machine(host: string): Promise<Machine | undefined>;
  hosts(): Promise<string[]>;
  // The Proxmox provider that names this host, if any (Proxmox requests only).
  providerFor?(host: string): Promise<ProviderConfig | undefined>;
}

export interface ExecutorPort {
  run(input: {
    host: string;
    machine: Machine;
    argv: string[];
    operationId: string;
    stdin?: string;
  }): Promise<ProcessResult>;
  // The Proxmox API transport. Absent: Proxmox operations fail before any request.
  proxmox?: ProxmoxPort;
  // The owner's setup routes. Absent: setup requests are refused at planning.
  setup?: SetupPort;
}

export interface EventsPort {
  emit(
    type: EventType,
    subject: string,
    audience: string[],
    data: Record<string, unknown>,
  ): Promise<void>;
}

export interface ExecInput {
  host: string;
  argv: string[];
  impact?: string;
  task?: string;
  narrative?: string;
}

export interface DecideInput {
  operationId: string;
  fingerprint: string;
  decision: DecisionKind;
  surface: string;
  // True only when the owner surface re-authenticated for this decision.
  stepUp: boolean;
  // Enrolment approvals: the fingerprint the owner typed from the card.
  confirmFingerprint?: string;
}

export interface DecideResult {
  operation: OperationView;
  grant?: Omit<ApprovalGrant, "signature" | "nonce">;
}
