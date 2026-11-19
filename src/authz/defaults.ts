// Presets and the read-only "effective permissions" view for the panel.
import {
  OWNER,
  type PolicyDocument,
  type PolicyMode,
  type ReviewerAuthority,
  type Rule,
  type Verdict,
} from "../core/contracts";
import { inWindow } from "./match";

export type Preset = "conservative" | "routine" | "delegated";

const PRESETS: Record<
  Preset,
  { mode: PolicyMode; authority: ReviewerAuthority }
> = {
  conservative: { mode: "rules", authority: "recommend" },
  routine: { mode: "rules", authority: "routine" },
  delegated: { mode: "auto", authority: "delegated" },
};

// The one built-in rule: read-only exec on any host, for any client, up to
// R1, never with sudo. Safe reads run without a prompt.
function defaultRule(now: number): Rule {
  return {
    id: "default-inspect",
    effect: "allow",
    match: {
      kinds: ["exec"],
      classifications: ["inspect"],
      maxRisk: "R1",
      sudo: false,
    },
    note: "Built-in: read-only inspection without a prompt",
    createdAt: now,
    createdBy: OWNER,
  };
}

export function defaultPolicy(preset: Preset, now = 0): PolicyDocument {
  const { mode, authority } = PRESETS[preset];
  return {
    version: 1,
    revision: 0,
    mode,
    reviewer: { authority, fallback: "ask", maxRisk: "R2" },
    rules: [defaultRule(now)],
    budgets: {
      taskMaxOperations: 50,
      taskMaxRiskPoints: 60,
      clientWindowMs: 3_600_000,
      clientMaxRiskPoints: 120,
    },
  };
}

export interface RuleExplanation {
  ruleId: string;
  effect: Verdict;
  // True when client, host and limits all allow the rule right now. Kind,
  // argv, classification and risk still narrow it per request.
  applies: boolean;
  reasons: string[];
}

export interface EffectiveView {
  revision: number;
  mode: PolicyMode;
  reviewerAuthority: ReviewerAuthority;
  rules: RuleExplanation[];
}

function explainRule(
  rule: Rule,
  client: string,
  host: string | undefined,
  now: number,
): RuleExplanation {
  const reasons: string[] = [];
  let applies = true;
  const block = (reason: string) => {
    applies = false;
    reasons.push(reason);
  };
  const { match, limits } = rule;
  if (match.clients !== undefined && !match.clients.includes(client))
    block("does not list this client");
  if (match.hosts !== undefined) {
    if (host === undefined) block("needs a host to match");
    else if (!match.hosts.includes(host)) block("does not list this host");
  }
  if (limits?.expiresAt !== undefined && now >= limits.expiresAt)
    block("has expired");
  if (limits?.maxUses !== undefined && (rule.uses ?? 0) >= limits.maxUses)
    block("has reached its use limit");
  if (limits?.window !== undefined && !inWindow(limits.window, now))
    block(
      `is outside its time window ${limits.window.start}-${limits.window.end}`,
    );
  if (
    match.kinds !== undefined ||
    match.argvPrefixes !== undefined ||
    match.classifications !== undefined ||
    match.resources !== undefined
  )
    reasons.push(
      "is further narrowed by kind, argv, classification or resource",
    );
  if (rule.effect === "allow")
    reasons.push(`covers risk up to ${match.maxRisk ?? "R2"}`);
  return { ruleId: rule.id, effect: rule.effect, applies, reasons };
}

// Read-only view of what the policy would do for a client on a host. Pure.
export function explainEffective(
  policy: PolicyDocument,
  client: string,
  host: string | undefined,
  now: number,
): EffectiveView {
  return {
    revision: policy.revision,
    mode: policy.mode,
    reviewerAuthority: policy.reviewer.authority,
    rules: policy.rules.map((rule) => explainRule(rule, client, host, now)),
  };
}
