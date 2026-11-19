// Hybrid rule editor backend: turns short owner text into a structured rule
// draft. Heuristic and deterministic. Whatever it cannot place becomes a
// residual note for the reviewer and never widens the match.
import type { RuleLimits, RuleMatch, Verdict } from "../core/contracts";
import { HomectlError } from "../types";
import { ALLOW_DEFAULT_MAX_RISK } from "./decision";

export interface KnownNames {
  hosts: string[];
  clients: string[];
}

export interface CompiledRule {
  effect: Verdict;
  match: RuleMatch;
  limits?: RuleLimits;
  residual?: string;
  explanation: string[];
  // Owner must confirm the scope before the draft is saved.
  needsConfirmation: boolean;
}

const MAX_TEXT = 500;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_DURATION_MS = 365 * DAY;
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "on",
  "to",
  "for",
  "of",
  "and",
  "by",
  "from",
  "in",
  "at",
  "any",
  "all",
  "this",
  "that",
  "it",
  "with",
  "host",
  "hosts",
  "client",
  "clients",
  "between",
  "only",
  "please",
  "is",
  "be",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word, case-insensitive. Hostname characters count as word characters,
// so "lab" does not match inside "lab-printer".
function takeNames(
  text: string,
  names: string[],
): { text: string; found: string[] } {
  const found: string[] = [];
  let rest = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(
      `(?<![A-Za-z0-9._-])${escapeRegExp(name)}(?![A-Za-z0-9._-])`,
      "i",
    );
    if (re.test(rest)) {
      if (!found.includes(name)) found.push(name);
      rest = rest.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  return { text: rest, found };
}

function parseClock(value: string): string | undefined {
  const found = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!found) return undefined;
  const hours = Number(found[1]);
  const minutes = Number(found[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function compileRule(
  text: string,
  known: KnownNames,
  now: number,
): CompiledRule {
  const source = text.trim();
  if (source.length === 0) throw new HomectlError(2, "Rule text is empty");
  if (source.length > MAX_TEXT)
    throw new HomectlError(
      2,
      `Rule text is longer than ${MAX_TEXT} characters`,
    );

  const explanation: string[] = [];
  let needsConfirmation = false;

  // 1. Backtick commands are exact argv prefixes.
  const argvPrefixes: string[][] = [];
  let rest = source.replace(/`([^`]+)`/g, (_match, command: string) => {
    const tokens = command
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (tokens.length > 0) {
      argvPrefixes.push(tokens);
      explanation.push(`Command prefix: ${tokens.join(" ")}`);
    }
    return " ";
  });

  // 2. Known names, so that a host called "ask-box" is not read as a verb.
  const hostTake = takeNames(rest, known.hosts);
  rest = hostTake.text;
  const clientTake = takeNames(rest, known.clients);
  rest = clientTake.text;
  const hosts = hostTake.found;
  const clients = clientTake.found;
  for (const host of hosts) explanation.push(`Host: ${host}`);
  for (const client of clients) explanation.push(`Client: ${client}`);

  // 3. Verbs. When several appear, the most restrictive one wins.
  const verbs: Verdict[] = [];
  const verbWords: [string, Verdict][] = [
    ["never", "deny"],
    ["deny", "deny"],
    ["ask", "ask"],
    ["allow", "allow"],
  ];
  for (const [word, verdict] of verbWords) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(rest)) verbs.push(verdict);
    rest = rest.replace(new RegExp(re.source, "gi"), " ");
  }
  let effect: Verdict;
  if (verbs.includes("deny")) effect = "deny";
  else if (verbs.includes("ask")) effect = "ask";
  else if (verbs.includes("allow")) effect = "allow";
  else {
    effect = "ask";
    explanation.push("No verb recognised; saved as ask");
  }
  if (new Set(verbs).size > 1)
    explanation.push(`Several verbs found; using ${effect}`);
  explanation.push(`Effect: ${effect}`);

  // 4. Classification.
  const match: RuleMatch = {};
  if (/\bread[- ]?only\b|\binspect(?:ion)?\b/i.test(rest)) {
    match.classifications = ["inspect"];
    explanation.push("Classification: inspect (read-only)");
    rest = rest.replace(/\bread[- ]?only\b|\binspect(?:ion)?\b/gi, " ");
  }

  // 5. Limits: duration and daily window.
  const limits: RuleLimits = {};
  const duration =
    /\bfor\s+(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|days?)\b/i.exec(rest);
  if (duration) {
    const count = Number(duration[1]);
    const unit = (duration[2] ?? "").toLowerCase();
    const unitMs = unit.startsWith("min")
      ? MINUTE
      : unit.startsWith("h")
        ? HOUR
        : DAY;
    const total = count * unitMs;
    if (total <= 0 || total > MAX_DURATION_MS) {
      needsConfirmation = true;
      explanation.push("Duration not understood; confirm the expiry");
    } else {
      limits.expiresAt = now + total;
      explanation.push(`Expires in ${count} ${unit}`);
    }
    rest = rest.replace(duration[0], " ");
  }
  const windowMatch =
    /\bbetween\s+(\d{1,2}:\d{2})\s+and\s+(\d{1,2}:\d{2})\b/i.exec(rest);
  if (windowMatch) {
    const start = parseClock(windowMatch[1] ?? "");
    const end = parseClock(windowMatch[2] ?? "");
    if (start === undefined || end === undefined || start === end) {
      needsConfirmation = true;
      explanation.push("Time window not understood; confirm it");
    } else {
      limits.window = { start, end };
      explanation.push(`Only between ${start} and ${end} local time`);
    }
    rest = rest.replace(windowMatch[0], " ");
  }

  // 6. Scope. Unscoped allows are never produced; they become asks.
  if (clients.length > 0) match.clients = clients;
  if (hosts.length > 0) match.hosts = hosts;
  if (argvPrefixes.length > 0) {
    match.argvPrefixes = argvPrefixes;
    match.kinds = ["exec"];
  }
  if (clients.length === 0 && hosts.length === 0) {
    needsConfirmation = true;
    explanation.push(
      "No host or client recognised; confirm the scope before saving",
    );
    if (effect === "allow") {
      effect = "ask";
      explanation.push("Allow needs a recognised host or client; saved as ask");
    }
  }
  if (effect === "allow") {
    match.maxRisk = ALLOW_DEFAULT_MAX_RISK;
    explanation.push(`Covers risk up to ${ALLOW_DEFAULT_MAX_RISK}`);
  }

  // 7. Residual words: kept as a note for the reviewer only.
  const words = rest
    .replace(/[^\p{L}\p{N}:._-]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w.toLowerCase()));
  const residual = words.length > 0 ? words.join(" ") : undefined;
  if (residual !== undefined)
    explanation.push(
      "Other words kept as a note; they do not change the match",
    );

  const compiled: CompiledRule = {
    effect,
    match,
    explanation,
    needsConfirmation,
  };
  if (Object.keys(limits).length > 0) compiled.limits = limits;
  if (residual !== undefined) compiled.residual = residual;
  return compiled;
}
