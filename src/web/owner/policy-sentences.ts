// Turns rules and effective-rights results into the sentences the owner reads.
// Display only: the broker decides, and these functions only describe what the
// broker already reports. A missing maxRisk means R2 for an allow rule and every
// risk for a deny or ask rule, as the broker applies them.
import type { EffectiveView, PolicyRule } from "./api";
import { riskPhrase } from "./permissions-copy";

const RISK_RANK: Record<string, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };
const ALLOW_DEFAULT_RANK = 2;
const EVERY_RISK_RANK = 4;

function listOf(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function maxRiskRank(rule: PolicyRule): number {
  const named = rule.match.maxRisk;
  if (typeof named === "string" && RISK_RANK[named] !== undefined)
    return RISK_RANK[named];
  return rule.effect === "allow" ? ALLOW_DEFAULT_RANK : EVERY_RISK_RANK;
}

function kindsAllowExec(rule: PolicyRule): boolean {
  const kinds = listOf(rule.match.kinds);
  return kinds === undefined || kinds.includes("exec");
}

// Covers looking around: a read-only check at R1 or below.
export function coversLookAround(rule: PolicyRule): boolean {
  const classes = listOf(rule.match.classifications);
  return (
    kindsAllowExec(rule) &&
    (classes === undefined || classes.includes("inspect")) &&
    maxRiskRank(rule) >= 1
  );
}

// Covers a change: a command at R2 or above.
export function coversChange(rule: PolicyRule): boolean {
  return kindsAllowExec(rule) && maxRiskRank(rule) >= ALLOW_DEFAULT_RANK;
}

// What the rule covers, in one plain phrase: "the exact command ... for Codex on
// pc, up to small, undoable changes". Names come from the assistants' list.
export function ruleCovers(
  rule: PolicyRule,
  names: Readonly<Record<string, string>>,
): string {
  const exact = listOf(rule.match.argvExact);
  const prefixes = listOf(rule.match.argvPrefixes);
  const lookingOnly = coversLookAround(rule) && !coversChange(rule);
  const subject = exact?.length
    ? `the exact command ${exact.map(commandText).join(" or ")}`
    : prefixes?.length
      ? `commands that start with ${prefixes.map(commandText).join(" or ")}`
      : lookingOnly
        ? "looking around"
        : "any request";
  const who = listOf(rule.match.clients);
  const whoText = who?.length
    ? `for ${who.map((id) => names[String(id)] ?? String(id)).join(", ")}`
    : "for any assistant";
  const where = listOf(rule.match.hosts);
  const whereText = where?.length
    ? `on ${where.map(String).join(", ")}`
    : "on any machine";
  const limit =
    typeof rule.match.maxRisk === "string" && !lookingOnly
      ? `, up to ${riskPhrase(rule.match.maxRisk)}`
      : "";
  const admin = rule.match.sudo === true ? " with admin rights" : "";
  return `${subject} ${whoText} ${whereText}${limit}${admin}`;
}

function commandText(value: unknown): string {
  const argv = listOf(value);
  const text = argv ? argv.map(String).join(" ") : String(value);
  return `"${text}"`;
}

// The plain facts a rule stores, with a short explanation of each key. Shown
// under "Why?" for a rule, so nothing is hidden, only moved out of the way.
export function ruleFacts(
  rule: PolicyRule,
  names: Readonly<Record<string, string>>,
): { term: string; value: string; key: string; meaning: string }[] {
  const meanings: Record<string, [string, string]> = {
    clients: ["Assistants", "The AI tools this rule is for."],
    hosts: ["Machines", "The computers this rule applies to."],
    kinds: ["Kind of request", "exec means run a command."],
    argvExact: ["Exact command", "Only this full command, nothing longer."],
    argvPrefixes: [
      "Commands starting with",
      "Any command that begins with these words.",
    ],
    classifications: [
      "What the command does",
      "inspect means looking around; it changes nothing.",
    ],
    maxRisk: [
      "Highest risk level",
      "R0 to R4. See the risk levels in Details.",
    ],
    sudo: [
      "Admin rights (sudo)",
      "Whether the command runs with admin rights.",
    ],
  };
  return Object.entries(rule.match).map(([key, raw]) => {
    const [term, meaning] = meanings[key] ?? [key, "Stored as this key."];
    const list = listOf(raw);
    let value: string;
    if (list === undefined) value = String(raw);
    else if (key === "clients")
      value = list.map((id) => names[String(id)] ?? String(id)).join(", ");
    else if (key === "argvExact" || key === "argvPrefixes")
      value = list.map(commandText).join(", ");
    else value = list.map(String).join(", ");
    return { term, value, key, meaning };
  });
}

// What one assistant can do on one machine, in two plain sentences. It uses the
// broker's answer for this pair and the mode and authority the broker reports.
export function pairSentence(input: {
  name: string;
  machine: string;
  view: EffectiveView;
  rules: PolicyRule[];
  reviewerReady: boolean;
}): string {
  const { name, machine, view, rules, reviewerReady } = input;
  const applying = view.rules
    .filter((entry) => entry.applies)
    .map((entry) => rules.find((rule) => rule.id === entry.ruleId))
    .filter((rule): rule is PolicyRule => rule !== undefined);
  const blockedLook = applying.some(
    (rule) => rule.effect === "deny" && coversLookAround(rule),
  );
  const allowedLook = applying.some(
    (rule) => rule.effect === "allow" && coversLookAround(rule),
  );
  const savedChanges = applying.some(
    (rule) => rule.effect === "allow" && coversChange(rule),
  );
  const blockedChanges = applying.some(
    (rule) => rule.effect === "deny" && coversChange(rule),
  );
  const lookSentence = blockedLook
    ? `${name} is blocked from looking around on ${machine}.`
    : allowedLook
      ? `${name} can look around on ${machine} without asking.`
      : `${name} asks you before it looks around on ${machine}.`;
  const aiMayDecide =
    view.mode === "auto" &&
    view.reviewerAuthority !== "recommend" &&
    reviewerReady;
  const aiLine =
    "The AI helper may approve small, undoable changes; big or risky ones still ask you.";
  const askLine = "It asks you before it changes anything.";
  const changeSentence = savedChanges
    ? `Some changes run without asking, because of your saved rules. ${aiMayDecide ? "The AI helper may approve other small, undoable changes; big or risky ones still ask you." : "Other changes ask you first."}`
    : aiMayDecide
      ? aiLine
      : askLine;
  const blocked = blockedChanges
    ? " Some changes are blocked by your rules."
    : "";
  return `${lookSentence} ${changeSentence}${blocked}`;
}

// Labels for the Result column, derived from the same facts.
export function ruleOwner(rule: PolicyRule): string {
  if (rule.id.startsWith("default-")) return "Built into homectl";
  return rule.createdBy === "owner" ? "Saved by you" : rule.createdBy;
}
