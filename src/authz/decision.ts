import {
  type ActionRequest,
  HUMAN_ONLY_KINDS,
  type PolicyDocument,
  riskAtLeast,
} from "../core/contracts";
import type { AuthzDecision, Outcome } from "./types";

export const DEFAULT_REVIEWER_TIMEOUT_MS = 8000;
// Allow rules without an explicit maxRisk cover routine work only.
export const ALLOW_DEFAULT_MAX_RISK = "R2" as const;

export function isHumanOnlyKind(kind: ActionRequest["kind"]): boolean {
  return HUMAN_ONLY_KINDS.includes(kind);
}

// Every decision carries the policy revision it was made under. stepUp is
// true for human-only kinds and for R3 or above, whatever the verdict.
export function stamp(
  policy: PolicyDocument,
  req: ActionRequest,
  outcome: Outcome,
  extra: Pick<AuthzDecision, "modelCalls" | "suggestion" | "reviewerReason"> = {
    modelCalls: 0,
  },
): AuthzDecision {
  const decision: AuthzDecision = {
    verdict: outcome.verdict,
    source: outcome.source,
    reason: outcome.reason,
    humanOnly: outcome.humanOnly ?? false,
    stepUp: isHumanOnlyKind(req.kind) || riskAtLeast(req.risk, "R3"),
    modelCalls: extra.modelCalls,
    policyRevision: policy.revision,
  };
  if (outcome.ruleId !== undefined) decision.ruleId = outcome.ruleId;
  if (extra.suggestion !== undefined) decision.suggestion = extra.suggestion;
  if (extra.reviewerReason !== undefined)
    decision.reviewerReason = extra.reviewerReason;
  return decision;
}
