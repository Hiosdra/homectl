// Authorization engine (0.3.0, Hiosdra/homelab#21). Pure decision logic with
// an injected clock; file and network access live only in store.ts and
// http-reviewer.ts.
export { type CompiledRule, compileRule, type KnownNames } from "./compile";
export {
  defaultPolicy,
  type EffectiveView,
  explainEffective,
  type Preset,
  type RuleExplanation,
} from "./defaults";
export { applyAuthority, evaluate } from "./evaluate";
export {
  type HttpReviewerOptions,
  httpReviewer,
  reviewerPayload,
} from "./http-reviewer";
export { exactMatch, ruleFromDecision, suggestRule } from "./remember";
export { narrowerThan, parseReviewerOutput, toReviewerInput } from "./reviewer";
export { loadPolicy, savePolicy } from "./store";
export type {
  AuthzDecision,
  EvaluateContext,
  Reviewer,
  ReviewerInput,
  ReviewerNarrative,
  ReviewerOutput,
} from "./types";
export { RULE_ID_PATTERN, validatePolicy } from "./validate";
