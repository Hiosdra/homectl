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
import { policyProviderId } from "./ai-providers";
import {
  emptyReviewerSettings,
  keyEndpointOf,
  normalizeEndpoint,
  normalizeModel,
  providerOf,
  REVIEWER_API_KEY_ENV,
  type ReviewerSettings,
} from "./reviewer-settings";
import type { KeyStatus } from "./reviewer-key";

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
  const keyEndpoint = keyEndpointOf(settings) ?? endpoint;
  if (keyEndpoint !== undefined) nextSettings.keyEndpoint = keyEndpoint;
  if (model !== undefined) nextSettings.model = model;
  // A provider survives only while its address is unchanged; a new address
  // set from the command line is a Custom one.
  if (settings.provider !== undefined && endpoint === settings.endpoint)
    nextSettings.provider = settings.provider;
  const provider = providerOf(nextSettings);
  const reviewer: PolicyDocument["reviewer"] = {
    authority,
    fallback: doc.reviewer.fallback,
    maxRisk: doc.reviewer.maxRisk,
    ...(provider !== undefined ? { provider: policyProviderId(provider) } : {}),
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

// Custom works without a key; the hosted providers need one. Ready means the
// policy and the settings both name a reviewer and any needed key is present.
export function reviewerReady(
  doc: PolicyDocument,
  settings: ReviewerSettings,
  key: KeyStatus,
): boolean {
  const provider = providerOf(settings);
  const keyNeeded = provider !== undefined && provider !== "custom";
  return (
    doc.reviewer.provider !== undefined &&
    settings.endpoint !== undefined &&
    settings.model !== undefined &&
    (!keyNeeded || key.source !== "none")
  );
}

export function autoModeView(
  doc: PolicyDocument,
  settings: ReviewerSettings,
  key: KeyStatus,
): Record<string, unknown> {
  return {
    revision: doc.revision,
    mode: doc.mode,
    reviewer: {
      authority: doc.reviewer.authority,
      fallback: doc.reviewer.fallback,
      maxRisk: doc.reviewer.maxRisk,
      provider: providerOf(settings) ?? null,
      endpoint: endpointOrigin(settings),
      model: settings.model,
      // Where the key comes from. The key itself is never part of any view.
      apiKey: key,
      apiKeyConfigured: key.source !== "none",
      ready: reviewerReady(doc, settings, key),
    },
    choices: { modes: MODES, authorities: AUTHORITIES },
  };
}
