// Auto Mode planning (homelab #21 A1): mode, reviewer authority and reviewer
// connection. Pure: it validates a requested change against the current policy
// and settings, and says whether the owner must confirm with the password. The
// routes save what it returns.
import type {
  PolicyDocument,
  PolicyMode,
  ReviewerAuthority,
} from "../core/contracts";
import { HomectlError } from "../types";
import {
  emptyReviewerSettings,
  normalizeEndpoint,
  normalizeModel,
  REVIEWER_API_KEY_ENV,
  REVIEWER_PROVIDER,
  type ReviewerSettings,
  reviewerFrom,
} from "./reviewer-settings";

export const MODES: readonly PolicyMode[] = ["manual", "rules", "auto"];
export const AUTHORITIES: readonly ReviewerAuthority[] = [
  "recommend",
  "routine",
  "delegated",
];
// Wider authority has a higher rank. Changing to a lower rank never needs step-up.
const RANK: Record<ReviewerAuthority, number> = {
  recommend: 0,
  routine: 1,
  delegated: 2,
};

export interface AutoModeChange {
  mode?: PolicyMode;
  authority?: ReviewerAuthority;
  // null removes the reviewer endpoint.
  endpoint?: string | null;
  model?: string;
}

export interface AutoModePlan {
  // Policy to save; the store bumps the revision.
  doc: PolicyDocument;
  settings: ReviewerSettings;
  // True when the owner must confirm with the password: the reviewer authority
  // widens, Auto Mode is turned on, or the reviewer is sent to a new endpoint.
  stepUp: boolean;
}

function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new HomectlError(2, `${field} must be one of ${choices.join(", ")}`);
  return value as T;
}

// Parses the untrusted route or CLI input. Unknown fields are refused.
export function parseAutoModeChange(
  input: Record<string, unknown>,
): AutoModeChange {
  const allowed = ["mode", "authority", "endpoint", "model", "password"];
  for (const key of Object.keys(input))
    if (!allowed.includes(key))
      throw new HomectlError(2, `Unknown field: ${key}`);
  const change: AutoModeChange = {};
  const mode = oneOf(input.mode, MODES, "mode");
  if (mode !== undefined) change.mode = mode;
  const authority = oneOf(input.authority, AUTHORITIES, "authority");
  if (authority !== undefined) change.authority = authority;
  if (input.endpoint === null) change.endpoint = null;
  else if (input.endpoint !== undefined)
    change.endpoint = normalizeEndpoint(input.endpoint);
  if (input.model !== undefined) change.model = normalizeModel(input.model);
  if (Object.keys(change).length === 0)
    throw new HomectlError(
      2,
      "Nothing to change: give mode, authority, endpoint or model",
    );
  return change;
}

export function planAutoMode(
  doc: PolicyDocument,
  settings: ReviewerSettings,
  change: AutoModeChange,
): AutoModePlan {
  const mode = change.mode ?? doc.mode;
  const authority = change.authority ?? doc.reviewer.authority;
  const endpoint =
    change.endpoint === null
      ? undefined
      : (change.endpoint ?? settings.endpoint);
  const model = change.model ?? settings.model;
  if (endpoint !== undefined && model === undefined)
    throw new HomectlError(2, "A reviewer endpoint needs a model name");
  if (mode === "auto" && (endpoint === undefined || model === undefined))
    throw new HomectlError(
      2,
      `Auto Mode needs a reviewer endpoint and model; set --endpoint and --model (the API key goes in ${REVIEWER_API_KEY_ENV})`,
    );
  const nextSettings: ReviewerSettings = emptyReviewerSettings();
  if (endpoint !== undefined) nextSettings.endpoint = endpoint;
  if (model !== undefined) nextSettings.model = model;
  const reviewer: PolicyDocument["reviewer"] = {
    authority,
    fallback: doc.reviewer.fallback,
    maxRisk: doc.reviewer.maxRisk,
    ...(endpoint !== undefined ? { provider: REVIEWER_PROVIDER } : {}),
  };
  const newEndpoint = endpoint !== undefined && endpoint !== settings.endpoint;
  const enablesAuto = mode === "auto" && doc.mode !== "auto";
  const widens = RANK[authority] > RANK[doc.reviewer.authority];
  return {
    doc: { ...doc, mode, reviewer },
    settings: nextSettings,
    stepUp: widens || enablesAuto || newEndpoint,
  };
}

// The origin only: paths and query strings are not shown or logged.
export function endpointOrigin(settings: ReviewerSettings): string | undefined {
  return settings.endpoint === undefined
    ? undefined
    : new URL(settings.endpoint).origin;
}

export function autoModeView(
  doc: PolicyDocument,
  settings: ReviewerSettings,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  return {
    revision: doc.revision,
    mode: doc.mode,
    reviewer: {
      authority: doc.reviewer.authority,
      fallback: doc.reviewer.fallback,
      maxRisk: doc.reviewer.maxRisk,
      endpoint: endpointOrigin(settings),
      model: settings.model,
      apiKeyConfigured: Boolean(env[REVIEWER_API_KEY_ENV]),
      // True only when the policy and the settings both name a reviewer.
      ready:
        doc.reviewer.provider !== undefined &&
        reviewerFrom(settings, env) !== undefined,
    },
    choices: { modes: MODES, authorities: AUTHORITIES },
  };
}
