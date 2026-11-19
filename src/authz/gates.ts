// Steps a–d of evaluation: fixed invariants, hard gates, task scope, budgets.
// Each returns an Outcome when it resolves the request, or undefined to pass.
import {
  type ActionRequest,
  CLIENT_ID_PATTERN,
  OWNER,
  type PolicyDocument,
  RISK_POINTS,
  riskAtLeast,
  type TaskRecord,
} from "../core/contracts";
import { isHumanOnlyKind } from "./decision";
import { matchesScope } from "./match";
import type { EvaluateContext, Outcome } from "./types";

function hasControlCharacter(value: string): boolean {
  return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

export function invariantOutcome(
  req: ActionRequest,
  knownHost: boolean,
): Outcome | undefined {
  const deny = (reason: string): Outcome => ({
    verdict: "deny",
    source: "invariant",
    reason,
  });
  if (req.client === OWNER || !CLIENT_ID_PATTERN.test(req.client))
    return deny("Client identity is not valid");
  if (req.host !== undefined && !knownHost)
    return deny("Host is not in the inventory");
  if (req.kind === "exec" && (req.argv === undefined || req.argv.length === 0))
    return deny("Exec requests need argv");
  if (req.argv?.some(hasControlCharacter))
    return deny("Argv contains a control character");
  return undefined;
}

// Human-only kinds and R4 always go to the owner with step-up. R3 is also
// held here unless an owner rule that allows exactly R3 covers the request;
// the rule itself is still evaluated later, so an R3 deny still wins.
export function hardGateOutcome(
  req: ActionRequest,
  r3Covered: boolean,
): Outcome | undefined {
  if (isHumanOnlyKind(req.kind))
    return {
      verdict: "ask",
      source: "hard-gate",
      reason: "This kind of action always needs the owner",
      humanOnly: true,
    };
  if (req.risk === "R4")
    return {
      verdict: "ask",
      source: "hard-gate",
      reason: "Destructive or trust-changing actions always need the owner",
      humanOnly: true,
    };
  if (req.risk === "R3" && !r3Covered)
    return {
      verdict: "ask",
      source: "hard-gate",
      reason: "Significant-risk actions need the owner",
      humanOnly: true,
    };
  return undefined;
}

export function taskOutcome(
  req: ActionRequest,
  task: TaskRecord | undefined,
  now: number,
): Outcome | undefined {
  if (task === undefined) return undefined;
  if (task.state !== "open" || now >= task.expiresAt)
    return {
      verdict: "deny",
      source: "invariant",
      reason: "The task is closed or expired",
    };
  if (task.scope !== undefined && !matchesScope(task.scope, req))
    return {
      verdict: "ask",
      source: "hard-gate",
      reason: "The request is outside the task's delegated scope",
      humanOnly: true,
    };
  return undefined;
}

// Checked before rules, so an allow rule cannot be used to split a large
// change into many small steps that each stay under the thresholds. Reads
// (R0/R1) change nothing, so they neither count against nor hit a budget;
// otherwise a long troubleshooting session would start prompting for cat.
export function budgetOutcome(
  req: ActionRequest,
  ctx: Pick<EvaluateContext, "task" | "clientRiskPoints">,
  policy: PolicyDocument,
): Outcome | undefined {
  if (!riskAtLeast(req.risk, "R2")) return undefined;
  const points = RISK_POINTS[req.risk];
  const budgets = policy.budgets;
  const ask = (reason: string): Outcome => ({
    verdict: "ask",
    source: "budget",
    reason,
    humanOnly: true,
  });
  if (ctx.task !== undefined) {
    if (ctx.task.used.operations + 1 > budgets.taskMaxOperations)
      return ask("The task operation budget is used up");
    if (ctx.task.used.riskPoints + points > budgets.taskMaxRiskPoints)
      return ask("The task risk budget is used up");
  }
  if (ctx.clientRiskPoints + points > budgets.clientMaxRiskPoints)
    return ask("The client risk budget is used up");
  return undefined;
}
