// The decision pipeline. Order is fixed and the first resolving step wins:
// a invariants, b hard gates, c task scope, d budgets, e owner rules,
// f mode, g reviewer, h default ask. Steps a–f never call the reviewer.
import {
  type ActionRequest,
  type PolicyDocument,
  riskAtLeast,
  type Verdict,
} from "../core/contracts";
import { DEFAULT_REVIEWER_TIMEOUT_MS, stamp } from "./decision";
import {
  budgetOutcome,
  hardGateOutcome,
  invariantOutcome,
  taskOutcome,
} from "./gates";
import { ruleApplies } from "./match";
import { consultReviewer, narrowerThan, toReviewerInput } from "./reviewer";
import type {
  AuthzDecision,
  EvaluateContext,
  Outcome,
  ReviewerOutput,
} from "./types";

const OUTSIDE_AUTHORITY = "Reviewer output was outside its authority";

function resolveRules(
  policy: PolicyDocument,
  req: ActionRequest,
  now: number,
): Outcome | undefined {
  const applicable = policy.rules.filter((rule) => ruleApplies(rule, req, now));
  const pick = (effect: Verdict) =>
    applicable.find((rule) => rule.effect === effect);
  const deny = pick("deny");
  if (deny)
    return {
      verdict: "deny",
      source: "rule",
      ruleId: deny.id,
      reason: "Denied by an owner rule",
    };
  const ask = pick("ask");
  if (ask)
    return {
      verdict: "ask",
      source: "rule",
      ruleId: ask.id,
      reason: "An owner rule asks for confirmation",
    };
  const allow = pick("allow");
  if (allow)
    return {
      verdict: "allow",
      source: "rule",
      ruleId: allow.id,
      reason: "Allowed by an owner rule",
    };
  return undefined;
}

// Maps a validated reviewer verdict through the policy's authority level.
export function applyAuthority(
  authority: PolicyDocument["reviewer"]["authority"],
  output: ReviewerOutput,
  req: ActionRequest,
): Outcome {
  const askOwner = (reason: string): Outcome => ({
    verdict: "ask",
    source: "reviewer",
    reason,
  });
  if (authority === "recommend")
    return askOwner("The owner decides; the reviewer only recommends");
  if (output.verdict === "deny")
    return {
      verdict: "deny",
      source: "reviewer",
      reason: "Reviewer denied the request",
    };
  if (output.verdict === "ask")
    return askOwner("Reviewer asked for owner confirmation");
  if (output.verdict === "allow") {
    const routine =
      riskAtLeast("R2", req.risk) &&
      (req.classification === "inspect" || req.classification === "mutation");
    if (authority === "routine")
      return routine
        ? {
            verdict: "allow",
            source: "reviewer",
            reason: "Allowed within routine reviewer authority",
          }
        : askOwner(OUTSIDE_AUTHORITY);
    // delegated: never above R2, whatever reviewer.maxRisk says.
    return riskAtLeast("R2", req.risk)
      ? {
          verdict: "allow",
          source: "reviewer",
          reason: "Allowed within delegated reviewer authority",
        }
      : askOwner(OUTSIDE_AUTHORITY);
  }
  return askOwner(OUTSIDE_AUTHORITY);
}

export async function evaluate(
  req: ActionRequest,
  ctx: EvaluateContext,
): Promise<AuthzDecision> {
  const { policy, now } = ctx;
  const finish = (outcome: Outcome) => stamp(policy, req, outcome);

  const invariant = invariantOutcome(req, ctx.knownHost);
  if (invariant) return finish(invariant);

  const r3Covered =
    req.risk === "R3" &&
    policy.rules.some(
      (rule) =>
        rule.effect === "allow" &&
        rule.match.maxRisk === "R3" &&
        ruleApplies(rule, req, now),
    );
  const gate = hardGateOutcome(req, r3Covered);
  if (gate) return finish(gate);

  const task = taskOutcome(req, ctx.task, now);
  if (task) return finish(task);

  const budget = budgetOutcome(req, ctx, policy);
  if (budget) return finish(budget);

  const ruled = resolveRules(policy, req, now);
  if (ruled) return finish(ruled);

  if (policy.mode !== "auto")
    return finish({
      verdict: "ask",
      source: "mode",
      reason: "No owner rule matched; the owner decides in this mode",
    });

  const reviewer = ctx.reviewer;
  const reviewerMayDecide =
    reviewer !== undefined &&
    policy.reviewer.provider !== undefined &&
    riskAtLeast(policy.reviewer.maxRisk, req.risk);
  if (reviewer === undefined || !reviewerMayDecide)
    return finish({
      verdict: "ask",
      source: "default",
      reason: "No owner rule matched and no reviewer applies; asking the owner",
    });

  const output = await consultReviewer(
    reviewer,
    toReviewerInput(req),
    ctx.reviewerTimeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS,
  );
  if (output === null)
    return stamp(
      policy,
      req,
      {
        verdict: policy.reviewer.fallback,
        source: "default",
        reason: "Reviewer unavailable or invalid; applying the fallback",
      },
      { modelCalls: 1 },
    );

  const outcome = applyAuthority(policy.reviewer.authority, output, req);
  const suggestion =
    output.suggestion !== undefined && narrowerThan(output.suggestion, req)
      ? output.suggestion
      : undefined;
  return stamp(policy, req, outcome, {
    modelCalls: 1,
    reviewerReason: output.reason,
    ...(suggestion !== undefined && outcome.verdict !== "allow"
      ? { suggestion }
      : {}),
  });
}
