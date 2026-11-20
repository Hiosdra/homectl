// What an operation keeps about its policy decision, and what its audit event
// carries. Kept apart from engine.ts to hold that file under the length limit.
// The reviewer's own words are never stored here: they are untrusted model
// output and stay out of records and prompts.
import type { PolicyDecision } from "../core/contracts";
import type { BrokerOperation } from "./types";

export function decisionRecord(
  decision: PolicyDecision,
): BrokerOperation["decision"] {
  return {
    verdict: decision.verdict,
    source: decision.source,
    reason: decision.reason,
    stepUp: decision.stepUp,
    humanOnly: decision.humanOnly,
    policyRevision: decision.policyRevision,
    modelCalls: decision.modelCalls,
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
  };
}

// Audit fields of operation.updated: who asked, where, and which decision path
// resolved it (a rule, the reviewer, the owner default...). No argv or output.
export function decisionAudit(op: BrokerOperation): Record<string, unknown> {
  return {
    state: op.state,
    host: op.host,
    risk: op.risk,
    client: op.client,
    source: op.decision.source,
    verdict: op.decision.verdict,
    modelCalls: op.decision.modelCalls ?? 0,
  };
}
