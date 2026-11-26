// Pure matching of rules and scopes against a request. No I/O.
import {
  type ActionRequest,
  type Risk,
  type Rule,
  type RuleLimits,
  type RuleMatch,
  riskAtLeast,
} from "../core/contracts";
import { ALLOW_DEFAULT_MAX_RISK } from "./decision";

function argvStartsWith(prefix: string[], argv: string[]): boolean {
  return prefix.length <= argv.length && prefix.every((t, i) => argv[i] === t);
}

// Every set field must match. Empty lists fail closed, except argvPrefixes,
// where an empty list means "no argv constraint" (as documented in contracts).
export function matchesScope(match: RuleMatch, req: ActionRequest): boolean {
  if (match.clients !== undefined && !match.clients.includes(req.client))
    return false;
  if (
    match.hosts !== undefined &&
    (req.host === undefined || !match.hosts.includes(req.host))
  )
    return false;
  if (match.kinds !== undefined && !match.kinds.includes(req.kind))
    return false;
  if (
    match.argvPrefixes !== undefined &&
    match.argvPrefixes.length > 0 &&
    (req.argv === undefined ||
      !match.argvPrefixes.some((p) => argvStartsWith(p, req.argv ?? [])))
  )
    return false;
  if (
    match.argvExact !== undefined &&
    (req.argv === undefined ||
      !match.argvExact.some(
        (e) =>
          e.length === req.argv?.length &&
          e.every((t, i) => req.argv?.[i] === t),
      ))
  )
    return false;
  if (
    match.classifications !== undefined &&
    (req.classification === undefined ||
      !match.classifications.includes(req.classification))
  )
    return false;
  if (
    match.resources !== undefined &&
    (req.resource === undefined || !match.resources.includes(req.resource))
  )
    return false;
  if (match.sudo !== undefined && match.sudo !== (req.sudo ?? false))
    return false;
  return true;
}

function minutesOf(hhmm: string): number {
  const found = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!found) return Number.NaN;
  return Number(found[1]) * 60 + Number(found[2]);
}

// Local wall-clock window. A window whose start is after its end crosses
// midnight (22:00 to 06:00 covers 23:30 and 01:00).
export function inWindow(
  window: { start: string; end: string },
  now: number,
): boolean {
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function limitsAllow(
  limits: RuleLimits | undefined,
  uses: number | undefined,
  now: number,
): boolean {
  if (limits === undefined) return true;
  if (limits.expiresAt !== undefined && now >= limits.expiresAt) return false;
  if (limits.maxUses !== undefined && (uses ?? 0) >= limits.maxUses)
    return false;
  if (limits.window !== undefined && !inWindow(limits.window, now))
    return false;
  return true;
}

// Deny and ask rules without maxRisk apply at every risk. Allow rules without
// maxRisk stop at routine (R2); R3 needs an explicit maxRisk "R3".
export function riskWithin(rule: Rule, risk: Risk): boolean {
  if (rule.effect === "allow")
    return riskAtLeast(rule.match.maxRisk ?? ALLOW_DEFAULT_MAX_RISK, risk);
  return (
    rule.match.maxRisk === undefined || riskAtLeast(rule.match.maxRisk, risk)
  );
}

export function ruleApplies(
  rule: Rule,
  req: ActionRequest,
  now: number,
): boolean {
  return (
    matchesScope(rule.match, req) &&
    limitsAllow(rule.limits, rule.uses, now) &&
    riskWithin(rule, req.risk)
  );
}
