// Browser side of Auto Mode settings (homelab #21 A1). Reads change nothing. A
// change goes first without the owner password; only when the broker answers
// "Confirm with the owner password" (403) does the panel ask for it and retry.
// The reviewer's API key is never read, shown or sent back: the panel only learns
// where the key comes from (environment, vault or none) and whether the vault is
// closed. The key is typed only during onboarding, and then only sent once.
import { OwnerApiError, ownerCall } from "./api";

export const AI_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "custom",
] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];
export type KeySource = "environment" | "vault" | "none";

export const AUTO_MODES = ["manual", "rules", "auto"] as const;
export type AutoModeName = (typeof AUTO_MODES)[number];
export const REVIEWER_AUTHORITIES = [
  "recommend",
  "routine",
  "delegated",
] as const;
export type ReviewerAuthority = (typeof REVIEWER_AUTHORITIES)[number];

export interface AutoModeView {
  revision: number;
  mode: AutoModeName;
  reviewer: {
    authority: ReviewerAuthority;
    fallback: string;
    maxRisk: string;
    // The origin only; paths and query strings are never shown.
    endpoint?: string;
    model?: string;
    // Which provider the helper uses; absent for settings saved before 0.3.
    provider?: AiProviderId;
    apiKeyConfigured: boolean;
    // Where the key comes from. The key itself is never part of the view.
    keySource: KeySource;
    // True while the vault is closed, so a saved key cannot be checked.
    keyLocked: boolean;
    ready: boolean;
  };
}

export interface AutoModeChange {
  mode?: AutoModeName;
  authority?: ReviewerAuthority;
  // null removes the reviewer endpoint.
  endpoint?: string | null;
  model?: string;
  password?: string;
}

// The broker's wording for a change that needs step-up (403, nothing changed).
const STEP_UP_MESSAGE = "Confirm with the owner password";

// Reads the settings. undefined when the broker has no Auto Mode route (404).
export async function readAutoMode(): Promise<AutoModeView | undefined> {
  try {
    return toAutoModeView(await ownerCall<unknown>("/v1/owner/auto-mode/get"));
  } catch (error) {
    if (error instanceof OwnerApiError && error.status === 404)
      return undefined;
    throw error;
  }
}

export async function saveAutoMode(
  change: AutoModeChange,
): Promise<AutoModeView> {
  const view = toAutoModeView(
    await ownerCall<unknown>("/v1/owner/auto-mode/set", { ...change }),
  );
  if (view === undefined)
    throw new Error("The broker sent an unreadable Auto Mode status.");
  return view;
}

// True when the broker wants the owner password before it makes this change.
export function needsOwnerPassword(error: unknown): boolean {
  return (
    error instanceof OwnerApiError &&
    error.status === 403 &&
    error.message === STEP_UP_MESSAGE
  );
}

// Accepts only the documented shape; anything else is treated as unreadable.
export function toAutoModeView(value: unknown): AutoModeView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const reviewer = raw.reviewer as Record<string, unknown> | undefined;
  if (typeof reviewer !== "object" || reviewer === null) return undefined;
  const mode = AUTO_MODES.find((item) => item === raw.mode);
  const authority = REVIEWER_AUTHORITIES.find(
    (item) => item === reviewer.authority,
  );
  if (
    typeof raw.revision !== "number" ||
    !Number.isInteger(raw.revision) ||
    mode === undefined ||
    authority === undefined ||
    typeof reviewer.fallback !== "string" ||
    typeof reviewer.maxRisk !== "string" ||
    typeof reviewer.apiKeyConfigured !== "boolean" ||
    typeof reviewer.ready !== "boolean"
  )
    return undefined;
  const endpoint = textOf(reviewer.endpoint, 300);
  const model = textOf(reviewer.model, 200);
  const provider = AI_PROVIDER_IDS.find((item) => item === reviewer.provider);
  const key = reviewer.apiKey as Record<string, unknown> | undefined;
  const keySource: KeySource =
    key?.source === "environment" || key?.source === "vault"
      ? key.source
      : "none";
  return {
    revision: raw.revision,
    mode,
    reviewer: {
      authority,
      fallback: reviewer.fallback,
      maxRisk: reviewer.maxRisk,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
      apiKeyConfigured: reviewer.apiKeyConfigured,
      keySource,
      keyLocked: key?.locked === true,
      ready: reviewer.ready,
    },
  };
}

function textOf(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

// What the owner typed in the form. Blank text means "keep what is there".
export interface AutoModeDraft {
  mode: AutoModeName;
  authority: ReviewerAuthority;
  endpoint: string;
  clearEndpoint: boolean;
  model: string;
}

export function draftOf(view: AutoModeView): AutoModeDraft {
  return {
    mode: view.mode,
    authority: view.reviewer.authority,
    endpoint: "",
    clearEndpoint: false,
    model: "",
  };
}

// Only the fields that differ from the saved settings. undefined when nothing
// differs, so the form cannot send an empty change.
export function autoModeChange(
  view: AutoModeView,
  draft: AutoModeDraft,
): AutoModeChange | undefined {
  const change: AutoModeChange = {};
  if (draft.mode !== view.mode) change.mode = draft.mode;
  if (draft.authority !== view.reviewer.authority)
    change.authority = draft.authority;
  if (draft.clearEndpoint && view.reviewer.endpoint !== undefined)
    change.endpoint = null;
  else {
    const endpoint = draft.endpoint.trim();
    if (endpoint !== "") change.endpoint = endpoint;
  }
  const model = draft.model.trim();
  if (model !== "" && model !== view.reviewer.model) change.model = model;
  return Object.keys(change).length === 0 ? undefined : change;
}
