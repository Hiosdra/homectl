// Owner approval grants (homelab #21 §4). A grant is issued by the broker only
// after the owner authenticated on an owner surface. It is bound to one exact
// plan (operation id + fingerprint), the issuing client, the policy revision,
// an expiry and a random nonce, and is signed with the broker's approval key.
// The agent never holds that key, so it cannot mint or alter a grant; the
// nonce ledger makes every grant single-use.
import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "../control/canonical";
import type { DeviceKey } from "../control/device-key";
import { signBytes, verifyBytes } from "../control/device-key";
import { type ApprovalGrant, OWNER } from "../core/contracts";

export const GRANT_TTL_MS = 5 * 60_000;

export interface GrantInput {
  operationId: string;
  fingerprint: string;
  client: string;
  host?: string;
  policyRevision: number;
  device: string;
  surface: string;
  stepUp: boolean;
  ruleId?: string;
  now: number;
  ttlMs?: number;
}

function payload(grant: Omit<ApprovalGrant, "signature">): string {
  return `homectl.approval/v1\n${canonicalJson(grant)}`;
}

export function issueGrant(key: DeviceKey, input: GrantInput): ApprovalGrant {
  const unsigned: Omit<ApprovalGrant, "signature"> = {
    v: 1,
    id: randomUUID(),
    operationId: input.operationId,
    fingerprint: input.fingerprint,
    client: input.client,
    ...(input.host === undefined ? {} : { host: input.host }),
    policyRevision: input.policyRevision,
    nonce: randomBytes(18).toString("base64url"),
    issuedAt: input.now,
    expiresAt: input.now + (input.ttlMs ?? GRANT_TTL_MS),
    approver: { kind: OWNER, device: input.device, surface: input.surface },
    stepUp: input.stepUp,
    ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
  };
  return {
    ...unsigned,
    signature: signBytes(key.privateKey, payload(unsigned)),
  };
}

export type GrantCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "signature"
        | "operation"
        | "fingerprint"
        | "client"
        | "policy-revision"
        | "expired"
        | "step-up"
        | "approver";
    };

export interface GrantExpectation {
  operationId: string;
  fingerprint: string;
  client: string;
  policyRevision: number;
  stepUpRequired: boolean;
  now: number;
}

// Pure verification. Consumption (single use) is the ledger's job.
export function checkGrant(
  publicKey: string,
  grant: ApprovalGrant,
  expected: GrantExpectation,
): GrantCheck {
  const { signature, ...unsigned } = grant;
  if (
    typeof signature !== "string" ||
    !verifyBytes(publicKey, payload(unsigned), signature)
  )
    return { ok: false, reason: "signature" };
  if (grant.approver?.kind !== OWNER) return { ok: false, reason: "approver" };
  if (grant.operationId !== expected.operationId)
    return { ok: false, reason: "operation" };
  if (grant.fingerprint !== expected.fingerprint)
    return { ok: false, reason: "fingerprint" };
  if (grant.client !== expected.client) return { ok: false, reason: "client" };
  if (grant.policyRevision !== expected.policyRevision)
    return { ok: false, reason: "policy-revision" };
  if (expected.now >= grant.expiresAt || expected.now < grant.issuedAt - 60_000)
    return { ok: false, reason: "expired" };
  if (expected.stepUpRequired && !grant.stepUp)
    return { ok: false, reason: "step-up" };
  return { ok: true };
}
