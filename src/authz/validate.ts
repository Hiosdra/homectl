// Strict validation of policy documents, rules and suggestions. Unknown fields
// are rejected everywhere. Throws HomectlError(2) with a field path.
import {
  ACTION_KINDS,
  type ActionKind,
  CLIENT_ID_PATTERN,
  type Classification,
  HUMAN_ONLY_KINDS,
  OWNER,
  type PolicyDocument,
  RISKS,
  type Risk,
  type Rule,
  type RuleLimits,
  type RuleMatch,
  type RuleSuggestion,
  riskAtLeast,
  type Verdict,
} from "../core/contracts";
import { HomectlError } from "../types";

export const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_RULES = 500;
const VERDICTS: readonly Verdict[] = ["allow", "deny", "ask"];
const CLASSIFICATIONS: readonly Classification[] = [
  "inspect",
  "mutation",
  "destructive",
  "opaque",
];
const MODES = ["manual", "rules", "auto"] as const;
const AUTHORITIES = ["recommend", "routine", "delegated"] as const;
const FALLBACKS = ["ask", "deny"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new HomectlError(2, `${path} ${message}`);
}

function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${path}.${key}`, "is not a known field");
  return value;
}

function text(value: unknown, path: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\0")
  )
    fail(path, `must be a non-empty string up to ${max} characters`);
  return value as string;
}

function token(value: unknown, path: string): string {
  const out = text(value, path, 512);
  if (out.includes("\r") || out.includes("\n"))
    fail(path, "has a control character");
  return out;
}

function pattern(value: unknown, path: string, re: RegExp): string {
  const out = text(value, path, 256);
  if (!re.test(out)) fail(path, "has an invalid format");
  return out;
}

function integer(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(path, `must be an integer from ${min} to ${max}`);
  return value as number;
}

function oneOf<const T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
): T {
  const found = options.find((option) => option === value);
  if (found === undefined) fail(path, `must be one of ${options.join(", ")}`);
  return found;
}

function list<T>(
  value: unknown,
  path: string,
  max: number,
  item: (v: unknown, p: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max)
    fail(path, `must be a non-empty array of at most ${max} items`);
  return (value as unknown[]).map((v, i) => item(v, `${path}[${i}]`));
}

function parseWindow(
  value: unknown,
  path: string,
): { start: string; end: string } {
  const window = object(value, path, ["start", "end"]);
  const start = pattern(window.start, `${path}.start`, HHMM_PATTERN);
  const end = pattern(window.end, `${path}.end`, HHMM_PATTERN);
  if (start === end) fail(path, "start and end must differ");
  return { start, end };
}

function parseLimits(value: unknown, path: string): RuleLimits {
  const raw = object(value, path, ["expiresAt", "maxUses", "window"]);
  const limits: RuleLimits = {};
  if (raw.expiresAt !== undefined)
    limits.expiresAt = integer(raw.expiresAt, `${path}.expiresAt`, 0, MAX_SAFE);
  if (raw.maxUses !== undefined)
    limits.maxUses = integer(raw.maxUses, `${path}.maxUses`, 1, 1_000_000);
  if (raw.window !== undefined)
    limits.window = parseWindow(raw.window, `${path}.window`);
  return limits;
}

function parseMatch(value: unknown, path: string): RuleMatch {
  const raw = object(value, path, [
    "clients",
    "hosts",
    "kinds",
    "argvPrefixes",
    "argvExact",
    "classifications",
    "resources",
    "maxRisk",
    "sudo",
  ]);
  const match: RuleMatch = {};
  if (raw.clients !== undefined)
    match.clients = list(raw.clients, `${path}.clients`, 100, (v, p) =>
      pattern(v, p, CLIENT_ID_PATTERN),
    );
  if (raw.hosts !== undefined)
    match.hosts = list(raw.hosts, `${path}.hosts`, 500, (v, p) =>
      pattern(v, p, HOST_PATTERN),
    );
  if (raw.kinds !== undefined)
    match.kinds = list(
      raw.kinds,
      `${path}.kinds`,
      ACTION_KINDS.length,
      (v, p) => oneOf<ActionKind>(v, p, ACTION_KINDS),
    );
  if (raw.argvPrefixes !== undefined) {
    if (!Array.isArray(raw.argvPrefixes) || raw.argvPrefixes.length > 100)
      fail(`${path}.argvPrefixes`, "must be an array of at most 100 prefixes");
    match.argvPrefixes = (raw.argvPrefixes as unknown[]).map((prefix, i) =>
      list(prefix, `${path}.argvPrefixes[${i}]`, 32, token),
    );
  }
  if (raw.argvExact !== undefined) {
    if (!Array.isArray(raw.argvExact) || raw.argvExact.length > 100)
      fail(`${path}.argvExact`, "must be an array of at most 100 argv lists");
    match.argvExact = (raw.argvExact as unknown[]).map((argv, i) =>
      list(argv, `${path}.argvExact[${i}]`, 64, token),
    );
  }
  if (raw.classifications !== undefined)
    match.classifications = list(
      raw.classifications,
      `${path}.classifications`,
      CLASSIFICATIONS.length,
      (v, p) => oneOf(v, p, CLASSIFICATIONS),
    );
  if (raw.resources !== undefined)
    match.resources = list(raw.resources, `${path}.resources`, 100, (v, p) =>
      text(v, p, 256),
    );
  if (raw.maxRisk !== undefined)
    match.maxRisk = oneOf<Risk>(raw.maxRisk, `${path}.maxRisk`, RISKS);
  if (raw.sudo !== undefined) {
    if (typeof raw.sudo !== "boolean")
      fail(`${path}.sudo`, "must be a boolean");
    match.sudo = raw.sudo;
  }
  return match;
}

// Allow rules must not cover R4 or human-only kinds. An allow rule with no
// client or host is only accepted when it is read-only and no higher than R1.
export function assertEffectScope(
  effect: Verdict,
  match: RuleMatch,
  path: string,
): void {
  if (effect !== "allow") return;
  if (match.maxRisk === "R4") fail(path, "allow rules never cover R4");
  if (match.kinds?.some((kind) => HUMAN_ONLY_KINDS.includes(kind)))
    fail(path, "allow rules cannot cover human-only kinds");
  if (match.clients !== undefined || match.hosts !== undefined) return;
  const readOnly =
    match.classifications?.length === 1 &&
    match.classifications[0] === "inspect" &&
    match.maxRisk !== undefined &&
    riskAtLeast("R1", match.maxRisk);
  if (!readOnly)
    fail(
      path,
      "allow rules need a client or host, or must be read-only (inspect, up to R1)",
    );
}

export function validateRule(value: unknown, path: string): Rule {
  const raw = object(value, path, [
    "id",
    "effect",
    "match",
    "limits",
    "semantic",
    "note",
    "createdAt",
    "createdBy",
    "uses",
  ]);
  const effect = oneOf<Verdict>(raw.effect, `${path}.effect`, VERDICTS);
  const match = parseMatch(raw.match, `${path}.match`);
  assertEffectScope(effect, match, path);
  const rule: Rule = {
    id: pattern(raw.id, `${path}.id`, RULE_ID_PATTERN),
    effect,
    match,
    createdAt: integer(raw.createdAt, `${path}.createdAt`, 0, MAX_SAFE),
    createdBy: OWNER,
  };
  if (raw.createdBy !== OWNER) fail(`${path}.createdBy`, `must be "${OWNER}"`);
  if (raw.limits !== undefined)
    rule.limits = parseLimits(raw.limits, `${path}.limits`);
  if (raw.semantic !== undefined)
    rule.semantic = text(raw.semantic, `${path}.semantic`, 500);
  if (raw.note !== undefined) rule.note = text(raw.note, `${path}.note`, 500);
  if (raw.uses !== undefined)
    rule.uses = integer(raw.uses, `${path}.uses`, 0, MAX_SAFE);
  return rule;
}

export function validateSuggestion(
  value: unknown,
  path: string,
): RuleSuggestion {
  const raw = object(value, path, ["effect", "match", "limits", "reason"]);
  const effect = oneOf<Verdict>(raw.effect, `${path}.effect`, VERDICTS);
  const match = parseMatch(raw.match, `${path}.match`);
  assertEffectScope(effect, match, path);
  const suggestion: RuleSuggestion = {
    effect,
    match,
    reason: text(raw.reason, `${path}.reason`, 300),
  };
  if (raw.limits !== undefined)
    suggestion.limits = parseLimits(raw.limits, `${path}.limits`);
  return suggestion;
}

function parseReviewer(value: unknown): PolicyDocument["reviewer"] {
  const raw = object(value, "policy.reviewer", [
    "authority",
    "fallback",
    "maxRisk",
    "provider",
  ]);
  const reviewer: PolicyDocument["reviewer"] = {
    authority: oneOf(raw.authority, "policy.reviewer.authority", AUTHORITIES),
    fallback: oneOf(raw.fallback, "policy.reviewer.fallback", FALLBACKS),
    maxRisk: oneOf<Risk>(raw.maxRisk, "policy.reviewer.maxRisk", RISKS),
  };
  if (raw.provider !== undefined)
    reviewer.provider = pattern(
      raw.provider,
      "policy.reviewer.provider",
      PROVIDER_PATTERN,
    );
  return reviewer;
}

function parseBudgets(value: unknown): PolicyDocument["budgets"] {
  const raw = object(value, "policy.budgets", [
    "taskMaxOperations",
    "taskMaxRiskPoints",
    "clientWindowMs",
    "clientMaxRiskPoints",
  ]);
  return {
    taskMaxOperations: integer(
      raw.taskMaxOperations,
      "policy.budgets.taskMaxOperations",
      0,
      10_000,
    ),
    taskMaxRiskPoints: integer(
      raw.taskMaxRiskPoints,
      "policy.budgets.taskMaxRiskPoints",
      0,
      10_000,
    ),
    clientWindowMs: integer(
      raw.clientWindowMs,
      "policy.budgets.clientWindowMs",
      60_000,
      30 * 86_400_000,
    ),
    clientMaxRiskPoints: integer(
      raw.clientMaxRiskPoints,
      "policy.budgets.clientMaxRiskPoints",
      0,
      10_000,
    ),
  };
}

// Validates a whole policy document. Returns a fresh object.
export function validatePolicy(value: unknown): PolicyDocument {
  const raw = object(value, "policy", [
    "version",
    "revision",
    "mode",
    "reviewer",
    "rules",
    "budgets",
  ]);
  if (raw.version !== 1) fail("policy.version", "must be 1");
  if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES)
    fail("policy.rules", `must be an array of at most ${MAX_RULES} rules`);
  const rules = (raw.rules as unknown[]).map((rule, i) =>
    validateRule(rule, `policy.rules[${i}]`),
  );
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) fail("policy.rules", `has duplicate id ${rule.id}`);
    ids.add(rule.id);
  }
  return {
    version: 1,
    revision: integer(raw.revision, "policy.revision", 0, MAX_SAFE),
    mode: oneOf(raw.mode, "policy.mode", MODES),
    reviewer: parseReviewer(raw.reviewer),
    rules,
    budgets: parseBudgets(raw.budgets),
  };
}
