// Browser side of the owner API. The session is the hc_owner cookie that the
// broker sets on sign-in: this module never reads, stores or puts a token in a
// URL. Secrets typed into forms are passed straight to the request and dropped.

import type { ProxmoxRequest } from "./proxmox";

// A setup request (see setup-request.tsx): the validated fields and, for an
// enrolment, the key the machine presented when the request was made.
export interface SetupView {
  kind: string;
  input: {
    name?: string;
    address?: string;
    port?: number;
    user?: string;
    access?: string;
    preset?: string;
    // The approval wait in milliseconds (approval-wait requests only).
    waitMs?: number;
  };
  presented?: { type: string; fingerprint: string }[];
}

export class OwnerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
  // The broker's message for "no owner session" (cookie missing or expired).
  get signedOut(): boolean {
    return (
      this.status === 401 ||
      (this.status === 403 && this.message === "Owner sign-in required")
    );
  }
  get brokerOffline(): boolean {
    return this.reason === "broker-offline";
  }
}

export interface Untrusted {
  untrusted: string;
}

export interface Decision {
  verdict: string;
  source: string;
  reason: string;
  stepUp?: boolean;
  humanOnly?: boolean;
  ruleId?: string;
  policyRevision?: number;
}

// One operation waiting for the owner (from /v1/owner/pending).
export interface PendingOperation {
  id: string;
  state: string;
  client: string;
  task?: string;
  host: string;
  argv: string[];
  impact?: string;
  classification: string;
  sudo?: boolean;
  risk: string;
  fingerprint: string;
  decision: Decision;
  createdAt: number;
  expiresAt: number;
  narrative?: Untrusted;
  // Proxmox requests: the typed request, its plain area, and whether only the
  // owner may approve it (see proxmox.tsx).
  proxmox?: ProxmoxRequest;
  area?: string;
  ownerOnly?: boolean;
  // Setup requests (setup-request.tsx). Their title and fields come from here.
  setup?: SetupView;
}

export type SecretFieldKind = "password" | "token" | "text" | "ssh-key";
export interface SecretField {
  name: string;
  label: string;
  kind: SecretFieldKind;
}
export type SecretDestination =
  | { kind: "ssh-stdin"; host: string; argv: string[] }
  | { kind: "http-header"; url: string; header: string }
  | { kind: "target-file"; host: string; path: string; mode: string }
  | { kind: "vault-only" };

// One secret request waiting for the owner (from /v1/owner/secrets/pending).
export interface PendingSecret {
  id: string;
  client: string;
  task?: string;
  purpose: Untrusted;
  destination: SecretDestination;
  fields: SecretField[];
  state: string;
  createdAt: number;
  expiresAt: number;
}

export interface ClientView {
  id: string;
  name: string;
  hosts: string[];
  scopes: string[];
  createdAt: string;
  revoked: boolean;
  hasToken: boolean;
}

export type PolicyRule = {
  id: string;
  effect: "allow" | "deny" | "ask";
  match: Record<string, unknown>;
  limits?: Record<string, unknown>;
  note?: string;
  createdBy: string;
  createdAt: number;
  uses?: number;
};

export interface PolicyDocument {
  version: 1;
  revision: number;
  mode: "manual" | "rules" | "auto";
  reviewer: { authority: string; fallback: string; maxRisk: string };
  rules: PolicyRule[];
  budgets: {
    taskMaxOperations: number;
    taskMaxRiskPoints: number;
    clientWindowMs: number;
    clientMaxRiskPoints: number;
  };
}

export interface EffectiveRule {
  ruleId: string;
  effect: string;
  applies: boolean;
  reasons: string[];
}

export interface EffectiveView {
  revision: number;
  mode: string;
  reviewerAuthority: string;
  rules: EffectiveRule[];
}

export interface DecideResult {
  operation: { id: string; state: string; reason?: string };
  grant?: unknown;
}

export async function ownerCall<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResponse<T>(response);
}

export async function ownerRead<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
  });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code?: number; message?: string; reason?: string };
  };
  if (!response.ok || data.error)
    throw new OwnerApiError(
      response.status,
      data.error?.code ?? 5,
      data.error?.message ?? `Request failed (${response.status})`,
      data.error?.reason,
    );
  return data as T;
}

// Some broker text is requester text. Show it as plain text, labelled.
export function untrustedText(value: Untrusted | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.untrusted;
}

// The message to show for a failed request. Broker messages are already
// plain sentences; a network failure gets its own wording.
export function describeError(error: unknown): string {
  if (error instanceof OwnerApiError) return error.message;
  return "The panel could not reach the broker. Check that it is still running.";
}
