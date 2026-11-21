// Agent-reported verification of an operation (homelab #21 §7). It is separate
// from the process exit status: homectl never sets it, never derives it from
// an exit code, and a passing exit status is not proof of service health. The
// agent checks the outcome itself and reports what it found.
import { HomectlError } from "../types";

export const VERIFICATION_STATUSES = [
  "passed",
  "failed",
  "inconclusive",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface AgentVerification {
  status: VerificationStatus;
  // Untrusted text from the agent; bounded, never machine-interpreted.
  summary: string;
  reportedAt: number;
}

// Only operations that actually ran have an outcome worth verifying.
export const VERIFIABLE_STATES = ["succeeded", "failed", "unknown"] as const;

const MAX_SUMMARY = 500;
const FIELDS = new Set(["status", "summary"]);

export function parseVerification(raw: unknown): {
  status: VerificationStatus;
  summary: string;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new HomectlError(2, "Verification must be an object");
  for (const key of Object.keys(raw))
    if (!FIELDS.has(key))
      throw new HomectlError(2, `Unknown verification field: ${key}`);
  const { status, summary } = raw as Record<string, unknown>;
  if (!VERIFICATION_STATUSES.includes(status as VerificationStatus))
    throw new HomectlError(
      2,
      "verification.status must be passed, failed or inconclusive",
    );
  if (typeof summary !== "string" || summary.trim() === "")
    throw new HomectlError(2, "verification.summary is required");
  if (summary.length > MAX_SUMMARY)
    throw new HomectlError(
      2,
      `verification.summary must be at most ${MAX_SUMMARY} characters`,
    );
  return { status: status as VerificationStatus, summary: summary.trim() };
}

// Records the agent's report once, on a finished operation. It touches only
// the verification field and updatedAt: state, exit result and reason stay.
export function recordVerification(
  op: {
    state: string;
    updatedAt: number;
    verification?: AgentVerification;
  },
  raw: unknown,
  now: number,
): void {
  const report = parseVerification(raw);
  if (
    !VERIFIABLE_STATES.includes(op.state as (typeof VERIFIABLE_STATES)[number])
  )
    throw new HomectlError(3, "Verify an operation after it has run");
  if (op.verification)
    throw new HomectlError(3, "This operation was already verified");
  op.verification = { ...report, reportedAt: now };
  op.updatedAt = now;
}
