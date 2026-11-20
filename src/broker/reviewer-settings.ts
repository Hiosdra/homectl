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

export const REVIEWER_PROVIDER = "openai-compatible";
export const REVIEWER_API_KEY_ENV = "HOMECTL_REVIEWER_API_KEY";
const MODEL_MAX = 100;

export interface ReviewerSettings {
  version: 1;
  // Normalized https URL, or loopback http. Never carries credentials.
  endpoint?: string;
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
    if (raw.endpoint !== undefined)
      settings.endpoint = normalizeEndpoint(raw.endpoint);
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

// The reviewer for these settings, or undefined when no endpoint and model are
// set. The API key is read from the environment on each call, never stored.
export function reviewerFrom(
  settings: ReviewerSettings,
  env: Record<string, string | undefined>,
): Reviewer | undefined {
  if (settings.endpoint === undefined || settings.model === undefined)
    return undefined;
  const key = env[REVIEWER_API_KEY_ENV];
  return httpReviewer({
    url: settings.endpoint,
    model: settings.model,
    getApiKey: async () => (key && key.length > 0 ? key : undefined),
  });
}
