// Reviewer connection settings for Auto Mode (homelab #21 A1/A2): the endpoint
// and model name of the optional reviewer. They live in their own file in the
// broker state directory, not in policy.json, so the policy stays free of URLs.
// No API key is stored anywhere here: the daemon reads it from the
// HOMECTL_REVIEWER_API_KEY environment variable when it builds the reviewer.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { httpReviewer, type Reviewer } from "../authz";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import { type AiProvider, isAiProvider } from "./ai-providers";

export const REVIEWER_PROVIDER = "openai-compatible";
export const REVIEWER_API_KEY_ENV = "HOMECTL_REVIEWER_API_KEY";
const MODEL_MAX = 100;

export interface ReviewerSettings {
  version: 1;
  // Which provider the helper talks to. Absent in settings saved before 0.3,
  // which were always an OpenAI-compatible address, so they read as Custom.
  provider?: AiProvider;
  // Normalized https URL, or loopback http. Never carries credentials.
  endpoint?: string;
  // Destination for credentials stored before keys carried their own binding,
  // and for the broker's environment key. Keep it across endpoint changes.
  keyEndpoint?: string;
  model?: string;
}

export function emptyReviewerSettings(): ReviewerSettings {
  return { version: 1 };
}

// Validates an endpoint the same way the reviewer adapter does, and refuses
// userinfo so a password cannot hide in the URL.
export function normalizeEndpoint(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500)
    throw new HomectlError(2, "Reviewer endpoint is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HomectlError(2, "Reviewer endpoint is not a valid URL");
  }
  if (url.username !== "" || url.password !== "")
    throw new HomectlError(
      2,
      "Reviewer endpoint must not contain credentials; the API key goes in HOMECTL_REVIEWER_API_KEY",
    );
  // Throws the adapter's own refusal for a non-https, non-loopback endpoint.
  httpReviewer({
    url: url.href,
    model: "validation",
    getApiKey: async () => undefined,
  });
  return url.href;
}

export function normalizeModel(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.trim().length === 0 ||
    raw.length > MODEL_MAX ||
    /\p{Cc}/u.test(raw)
  )
    throw new HomectlError(
      2,
      "Reviewer model name is required (up to 100 characters)",
    );
  return raw.trim();
}

function corrupt(): HomectlError {
  return new HomectlError(
    5,
    "Reviewer settings are corrupt; restore them or set them again",
  );
}

function parseSettings(value: unknown): ReviewerSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw corrupt();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw corrupt();
  const settings: ReviewerSettings = { version: 1 };
  try {
    if (raw.provider !== undefined) {
      if (!isAiProvider(raw.provider)) throw corrupt();
      settings.provider = raw.provider;
    }
    if (raw.endpoint !== undefined)
      settings.endpoint = normalizeEndpoint(raw.endpoint);
    if (raw.keyEndpoint !== undefined)
      settings.keyEndpoint = normalizeEndpoint(raw.keyEndpoint);
    if (raw.model !== undefined) settings.model = normalizeModel(raw.model);
  } catch {
    throw corrupt();
  }
  return settings;
}

// A missing file means nothing is configured; a damaged one is an error, and
// the reviewer resolver treats that error as "no reviewer" (the owner decides).
export async function loadReviewerSettings(
  path: string,
): Promise<ReviewerSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyReviewerSettings();
    throw new HomectlError(5, "Reviewer settings cannot be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  return parseSettings(parsed);
}

export async function saveReviewerSettings(
  path: string,
  settings: ReviewerSettings,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await atomicReplace(temp, path);
}

// The provider these settings use. Settings saved before 0.3 have an address
// and no provider; they are Custom, which is what they always were.
export function providerOf(settings: ReviewerSettings): AiProvider | undefined {
  if (settings.endpoint === undefined) return undefined;
  return settings.provider ?? "custom";
}

export function keyEndpointOf(settings: ReviewerSettings): string | undefined {
  return settings.keyEndpoint ?? settings.endpoint;
}

export function environmentReviewerKey(
  env: Record<string, string | undefined>,
  settings: ReviewerSettings,
): string | undefined {
  const key = env[REVIEWER_API_KEY_ENV];
  return settings.endpoint !== undefined &&
    settings.endpoint === keyEndpointOf(settings) &&
    key &&
    key.length > 0
    ? key
    : undefined;
}

export const NO_KEY_MESSAGE =
  "Add an API key for the AI helper in the owner panel. Until then, you decide each request.";

// The reviewer for these settings, or undefined when no endpoint and model are
// set. The key is read on every call and never stored here: the environment
// variable wins, then readVault (the vault entry, when given). A provider that
// needs a key and has none fails the review, so the owner decides.
export function reviewerFrom(
  settings: ReviewerSettings,
  env: Record<string, string | undefined>,
  readVault?: () => Promise<string | undefined>,
): Reviewer | undefined {
  if (settings.endpoint === undefined || settings.model === undefined)
    return undefined;
  const provider = providerOf(settings) ?? "custom";
  const fromEnv = environmentReviewerKey(env, settings);
  return httpReviewer({
    url: settings.endpoint,
    model: settings.model,
    protocol: provider === "anthropic" ? "anthropic-messages" : "openai-chat",
    getApiKey: async () => {
      const key = fromEnv ?? (await readVault?.());
      if (key === undefined && provider !== "custom")
        throw new HomectlError(5, NO_KEY_MESSAGE);
      return key;
    },
  });
}
