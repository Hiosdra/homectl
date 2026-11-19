// Reviewer boundary: builds the only payload a reviewer may see, validates its
// answer strictly, and bounds the wait. Nothing here decides on its own; the
// evaluator applies the authority level to the validated verdict.
import {
  type ActionRequest,
  type RuleSuggestion,
  riskAtLeast,
} from "../core/contracts";
import type { Reviewer, ReviewerInput, ReviewerOutput } from "./types";
import { isRecord, validateSuggestion } from "./validate";

const NARRATIVE_MAX = 1000;
const REASON_MAX = 300;

export function toReviewerInput(req: ActionRequest): ReviewerInput {
  const input: ReviewerInput = { kind: req.kind, risk: req.risk };
  if (req.host !== undefined) input.host = req.host;
  if (req.argv !== undefined) input.argv = [...req.argv];
  if (req.classification !== undefined)
    input.classification = req.classification;
  if (req.sudo !== undefined) input.sudo = req.sudo;
  if (req.resource !== undefined) input.resource = req.resource;
  if (req.narrative !== undefined && req.narrative.length > 0)
    input.narrative = {
      trust: "untrusted",
      text: req.narrative.slice(0, NARRATIVE_MAX),
    };
  return input;
}

const VERDICT_FIELDS = ["verdict", "reason", "suggestion"];

// Exactly {verdict, reason, suggestion?}; anything else yields null.
export function parseReviewerOutput(raw: unknown): ReviewerOutput | null {
  if (!isRecord(raw)) return null;
  if (!Object.keys(raw).every((key) => VERDICT_FIELDS.includes(key)))
    return null;
  const { verdict, reason, suggestion } = raw;
  if (verdict !== "allow" && verdict !== "deny" && verdict !== "ask")
    return null;
  if (typeof reason !== "string" || reason.length > REASON_MAX) return null;
  const output: ReviewerOutput = { verdict, reason };
  if (suggestion !== undefined) {
    try {
      output.suggestion = validateSuggestion(suggestion, "reviewer.suggestion");
    } catch {
      return null;
    }
  }
  return output;
}

// Resolves to validated output, or null on timeout, throw or invalid output.
export async function consultReviewer(
  reviewer: Reviewer,
  input: ReviewerInput,
  timeoutMs: number,
): Promise<ReviewerOutput | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const answered = new Promise<unknown>((resolve) => {
    resolve(reviewer.review(input, controller.signal));
  }).catch(() => null);
  try {
    return parseReviewerOutput(await Promise.race([answered, timedOut]));
  } finally {
    clearTimeout(timer);
  }
}

// A suggestion is kept only if it can be no broader than the request itself.
// Every field it sets must equal the request's value, and an allow must name
// both the client and the host.
export function narrowerThan(
  suggestion: RuleSuggestion,
  req: ActionRequest,
): boolean {
  const { match, effect } = suggestion;
  if (
    match.clients !== undefined &&
    !match.clients.every((c) => c === req.client)
  )
    return false;
  if (match.hosts !== undefined) {
    if (req.host === undefined) return false;
    if (!match.hosts.every((h) => h === req.host)) return false;
  }
  if (match.kinds !== undefined && !match.kinds.every((k) => k === req.kind))
    return false;
  if (match.argvPrefixes !== undefined && match.argvPrefixes.length > 0) {
    const argv = req.argv ?? [];
    const ok = match.argvPrefixes.every(
      (p) => p.length <= argv.length && p.every((t, i) => argv[i] === t),
    );
    if (!ok) return false;
  }
  if (
    match.classifications !== undefined &&
    !match.classifications.every((c) => c === req.classification)
  )
    return false;
  if (
    match.resources !== undefined &&
    !match.resources.every((r) => r === req.resource)
  )
    return false;
  if (match.maxRisk !== undefined && !riskAtLeast(req.risk, match.maxRisk))
    return false;
  if (match.sudo !== undefined && match.sudo !== (req.sudo ?? false))
    return false;
  if (
    effect === "allow" &&
    (match.clients === undefined || match.hosts === undefined)
  )
    return false;
  return true;
}
