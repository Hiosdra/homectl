// Engine-local types. Shared shapes come from core/contracts.ts; nothing here
// may narrow or rename them.
import type {
  ActionKind,
  Classification,
  PolicyDecision,
  PolicyDocument,
  Risk,
  RuleSuggestion,
  TaskRecord,
  Verdict,
} from "../core/contracts";

// The only fields a reviewer ever receives. Client identity, task text,
// parameters and the policy itself are never sent.
export interface ReviewerNarrative {
  trust: "untrusted";
  text: string;
}

export interface ReviewerInput {
  kind: ActionKind;
  host?: string;
  argv?: string[];
  classification?: Classification;
  sudo?: boolean;
  risk: Risk;
  resource?: string;
  narrative?: ReviewerNarrative;
}

export interface Reviewer {
  id: string;
  review(input: ReviewerInput, signal: AbortSignal): Promise<unknown>;
}

// Validated reviewer output. Anything else is treated as "no output".
export interface ReviewerOutput {
  verdict: Verdict;
  reason: string;
  suggestion?: RuleSuggestion;
}

// PolicyDecision plus the reviewer's own (model-written) reason, kept apart
// from the fixed `reason` so that model text never reaches an approval prompt
// as if it were engine output.
export interface AuthzDecision extends PolicyDecision {
  reviewerReason?: string;
}

export interface EvaluateContext {
  policy: PolicyDocument;
  task?: TaskRecord;
  clientRiskPoints: number;
  knownHost: boolean;
  now: number;
  reviewer?: Reviewer;
  reviewerTimeoutMs?: number;
}

// Internal: what a gate or rule step resolved to, before it is stamped with
// the policy revision and step-up flags.
export interface Outcome {
  verdict: Verdict;
  source: PolicyDecision["source"];
  reason: string;
  humanOnly?: boolean;
  ruleId?: string;
}
