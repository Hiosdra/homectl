// Browser side of the workspace server's owner routes (homelab #21 §6). This
// broker is a workspace server only when HOMECTL_WORKSPACE_LISTEN is set; any
// other broker answers 404 here, and the panel then hides the whole section.
// Requester text stays untrusted (`narrative`), and no password is kept after
// a request is sent.
import type { DecisionSource } from "../../core/contracts";
import {
  OwnerApiError,
  ownerCall,
  type SecretDestination,
  type SecretField,
  type Untrusted,
} from "./api";

export interface WorkspaceServerInfo {
  id: string;
  name: string;
  clients: number;
}

export interface WorkspaceBackup {
  latestSeq: number | null;
  latestAt: number | null;
  count: number;
  bytes: number;
  oldestAt: number | null;
}

// One linked client, as the server mirrors it. `stale` is computed by the
// server; a client that has not synced recently is shown as stale, not live.
export interface WorkspaceClient {
  id: string;
  name: string;
  platform: string;
  joinedAt: number;
  lastSeenAt: number | null;
  stale: boolean;
  remoteApproval: boolean;
  vaultUnlocked: boolean;
  pending: number;
  mirror: { lastSeq: number; gaps: number };
  backup: WorkspaceBackup;
  // True until the client's next sync takes the backup it was asked for.
  backupRequested?: boolean;
}

export type WorkspaceDecision = "approve-once" | "deny-once";
export type WorkspaceIntentStatus =
  "queued" | "delivered" | "applied" | "refused";

// The newest decision queued for a pending operation, as the server reports it
// on /pending. Null when none was queued.
export interface WorkspacePendingIntent {
  id: string;
  decision: WorkspaceDecision;
  status: WorkspaceIntentStatus;
  reason?: string;
  expiresAt: number;
}

// One operation waiting on a linked client. `origin` is the linked client id.
// `source` is "review" while the Auto Mode reviewer has not decided.
export interface WorkspacePending {
  origin: string;
  originName: string;
  id: string;
  client: string;
  host: string;
  argv: string[];
  risk: string;
  fingerprint: string;
  reason: string;
  source?: DecisionSource;
  stepUp: boolean;
  humanOnly: boolean;
  expiresAt: number;
  narrative?: Untrusted;
  intent: WorkspacePendingIntent | null;
}

// The server's record of a decision it queued for a client (the response to
// a decide request).
export interface WorkspaceIntent {
  id: string;
  operationId: string;
  fingerprint: string;
  decision: WorkspaceDecision;
  stepUp: boolean;
  createdAt: number;
  expiresAt: number;
  status: WorkspaceIntentStatus;
  reason?: string;
}

// One row of the decision history, newest first.
export interface WorkspaceIntentRow {
  id: string;
  operationId: string;
  client: string;
  decision: WorkspaceDecision;
  status: WorkspaceIntentStatus;
  reason?: string;
  expiresAt: number;
}

// How the panel describes a queued decision. Queued and delivered decisions
// block the buttons: the client has not applied them yet.
export interface IntentState {
  text: string;
  tone: "neutral" | "warn" | "bad" | "good";
  blocks: boolean;
  applied: boolean;
  refused: boolean;
}

export function intentState(
  intent:
    | Pick<
        WorkspacePendingIntent,
        "decision" | "status" | "reason" | "expiresAt"
      >
    | null
    | undefined,
): IntentState | undefined {
  if (!intent) return undefined;
  const word = intent.decision === "approve-once" ? "Approval" : "Denial";
  switch (intent.status) {
    case "queued":
      return {
        text: `${word} queued for the client. It applies at the client's next sync.`,
        tone: "warn",
        blocks: true,
        applied: false,
        refused: false,
      };
    case "delivered":
      return {
        text: `${word} delivered to the client. Waiting for it to apply.`,
        tone: "warn",
        blocks: true,
        applied: false,
        refused: false,
      };
    case "applied":
      return {
        text: `${word} applied by the client.`,
        tone: "good",
        blocks: false,
        applied: true,
        refused: false,
      };
    case "refused":
      return {
        text: `${word} refused by the client${intent.reason ? `: ${intent.reason}` : "."}`,
        tone: "bad",
        blocks: false,
        applied: false,
        refused: true,
      };
  }
}

export interface WorkspaceInvite {
  code: string;
  expiresAt: string;
  server: { id: string; name: string };
}

// Resolves to the server description, or undefined when this broker has no
// workspace server (the route is not there). Other failures still throw.
export async function probeWorkspace(): Promise<
  WorkspaceServerInfo | undefined
> {
  try {
    return await ownerCall<WorkspaceServerInfo>("/v1/owner/workspace/server");
  } catch (error) {
    if (error instanceof OwnerApiError && error.status === 404)
      return undefined;
    throw error;
  }
}

export function listWorkspaceClients(): Promise<WorkspaceClient[]> {
  return ownerCall<WorkspaceClient[]>("/v1/owner/workspace/clients");
}

export function listWorkspacePending(): Promise<WorkspacePending[]> {
  return ownerCall<WorkspacePending[]>("/v1/owner/workspace/pending");
}

// The newest decisions across linked clients, bounded by the server.
export async function listWorkspaceIntents(): Promise<WorkspaceIntentRow[]> {
  const result = await ownerCall<{ intents: WorkspaceIntentRow[] }>(
    "/v1/owner/workspace/intents",
  );
  return result.intents;
}

// The owner password is needed only for a step-up decision. The caller clears
// its own copy right after the request is sent.
export function decideWorkspace(input: {
  client: string;
  operationId: string;
  fingerprint: string;
  decision: WorkspaceDecision;
  password?: string;
}): Promise<WorkspaceIntent> {
  return ownerCall<WorkspaceIntent>("/v1/owner/workspace/decide", input);
}

export function createWorkspaceInvite(
  password: string,
): Promise<WorkspaceInvite> {
  return ownerCall<WorkspaceInvite>("/v1/owner/workspace/invite", { password });
}

export function removeWorkspaceClient(
  client: string,
  password: string,
): Promise<{ removed: string }> {
  return ownerCall<{ removed: string }>("/v1/owner/workspace/remove", {
    client,
    password,
  });
}

// What the panel offers for one pending operation, from data the server
// already holds. The server enforces the same rules; this only decides which
// buttons exist.
export interface DecisionOffer {
  approve: boolean;
  deny: boolean;
  // Why an approval is not offered, in plain words.
  note?: string;
}

export function decisionOffer(
  operation: Pick<WorkspacePending, "stepUp">,
  client: Pick<WorkspaceClient, "remoteApproval"> | undefined,
): DecisionOffer {
  if (client === undefined)
    return {
      approve: false,
      deny: false,
      note: "This client is no longer linked to this server.",
    };
  if (!client.remoteApproval)
    return {
      approve: false,
      deny: false,
      note: "This client does not accept approvals from this server. Decide on its own device.",
    };
  if (operation.stepUp)
    return {
      approve: false,
      deny: true,
      note: "This needs step-up. Approve it on its own device; you can still deny it here.",
    };
  return { approve: true, deny: true };
}

// The key a decision is tracked under on this page.
export function decisionKey(origin: string, operationId: string): string {
  return `${origin}:${operationId}`;
}

export interface WorkspaceSecretIntent {
  id: string;
  action: "provide" | "decline";
  status: WorkspaceIntentStatus;
  reason?: string;
  expiresAt: number;
}

export interface WorkspacePendingSecret {
  origin: string;
  originName: string;
  id: string;
  client: string;
  task?: string;
  purpose: Untrusted;
  destination: SecretDestination;
  fields: SecretField[];
  admin: boolean;
  canSave: boolean;
  requestExpiresAt: number;
  intent: WorkspaceSecretIntent | null;
}

export function secretIntentState(
  intent: WorkspaceSecretIntent | null | undefined,
): IntentState | undefined {
  if (!intent) return undefined;
  const word = intent.action === "provide" ? "Secret" : "Decline";
  switch (intent.status) {
    case "queued":
      return {
        text: `${word} queued for the client. It applies at the client's next sync.`,
        tone: "warn",
        blocks: true,
        applied: false,
        refused: false,
      };
    case "delivered":
      return {
        text: `${word} delivered to the client. Waiting for it to apply.`,
        tone: "warn",
        blocks: true,
        applied: false,
        refused: false,
      };
    case "applied":
      return {
        text: `${word} applied by the client.`,
        tone: "good",
        blocks: false,
        applied: true,
        refused: false,
      };
    case "refused":
      return {
        text: `${word} refused by the client${intent.reason ? `: ${intent.reason}` : "."}`,
        tone: "bad",
        blocks: false,
        applied: false,
        refused: true,
      };
  }
}

export async function listWorkspaceSecrets(): Promise<
  WorkspacePendingSecret[]
> {
  try {
    return await ownerCall<WorkspacePendingSecret[]>(
      "/v1/owner/workspace/secrets/pending",
    );
  } catch (error) {
    if (error instanceof OwnerApiError && error.status === 404) return [];
    throw error;
  }
}

export function provideWorkspaceSecret(input: {
  client: string;
  id: string;
  values: Record<string, string>;
  retention: "ephemeral" | "saved";
  saveName?: string;
  reuse?: boolean;
  password: string;
}): Promise<WorkspaceSecretIntent> {
  return ownerCall<WorkspaceSecretIntent>(
    "/v1/owner/workspace/secrets/provide",
    input,
  );
}

export function declineWorkspaceSecret(input: {
  client: string;
  id: string;
}): Promise<WorkspaceSecretIntent> {
  return ownerCall<WorkspaceSecretIntent>(
    "/v1/owner/workspace/secrets/decline",
    input,
  );
}

export async function readWorkspaceSnapshot() {
  const [clients, pending, secrets, intents] = await Promise.all([
    listWorkspaceClients(),
    listWorkspacePending(),
    listWorkspaceSecrets(),
    listWorkspaceIntents(),
  ]);
  return { clients, pending, secrets, intents };
}
