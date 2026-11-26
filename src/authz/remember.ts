// Remember rules: narrow rules built from one request. Nothing here installs a
// rule; the owner accepts one through the broker.
import {
  type ActionRequest,
  HUMAN_ONLY_KINDS,
  OWNER,
  type Rule,
  type RuleMatch,
  type RuleSuggestion,
  type Verdict,
} from "../core/contracts";
import { HomectlError } from "../types";
import { RULE_ID_PATTERN } from "./validate";

// Refuses anything that could widen beyond this exact request. Allow rules
// need a host and an argv (for exec); human-only kinds and R4 never allow.
function assertAllowable(req: ActionRequest): void {
  if (HUMAN_ONLY_KINDS.includes(req.kind) || req.risk === "R4")
    throw new HomectlError(3, "This action cannot be allowed by a rule");
  if (req.host === undefined)
    throw new HomectlError(2, "An allow rule needs an exact host");
  if (req.kind === "exec" && (req.argv === undefined || req.argv.length === 0))
    throw new HomectlError(2, "An exec allow rule needs exact argv");
}

// Exact client, host, kind, argv, risk and sudo. Never a wildcard, and the
// argv must match completely (a longer command does not match).
export function exactMatch(req: ActionRequest): RuleMatch {
  const match: RuleMatch = {
    clients: [req.client],
    kinds: [req.kind],
    maxRisk: req.risk,
    sudo: req.sudo ?? false,
  };
  if (req.host !== undefined) match.hosts = [req.host];
  if (req.argv !== undefined && req.argv.length > 0)
    match.argvExact = [[...req.argv]];
  if (req.resource !== undefined) match.resources = [req.resource];
  return match;
}

export function ruleFromDecision(
  req: ActionRequest,
  effect: Verdict,
  now: number,
  id: string,
): Rule {
  if (!RULE_ID_PATTERN.test(id)) throw new HomectlError(2, "Invalid rule id");
  if (effect === "allow") assertAllowable(req);
  return {
    id,
    effect,
    match: exactMatch(req),
    createdAt: now,
    createdBy: OWNER,
  };
}

export function suggestRule(req: ActionRequest): RuleSuggestion {
  assertAllowable(req);
  return {
    effect: "allow",
    match: exactMatch(req),
    reason: "Allow this exact action on this host for this client",
  };
}
