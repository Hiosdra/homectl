// The AI helper's model list and test call (0.3 onboarding). Both run in the
// broker, so the key is never sent from the browser and CORS does not apply.
// Failures become plain sentences for the owner; the provider's own text,
// the key and the full address are never returned.
import {
  ANTHROPIC_VERSION,
  httpReviewer,
  ReviewerRequestError,
  type ReviewerProtocol,
} from "../authz/http-reviewer";
import { parseReviewerOutput } from "../authz/reviewer";
import { HomectlError } from "../types";
import type { ProviderSpec } from "./ai-providers";

const LIST_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;
const MAX_MODELS = 300;
const MAX_TEXT = 200;

export interface ModelPrice {
  // US dollars per one million tokens.
  promptPerMillion: number;
  completionPerMillion: number;
}

export interface ModelEntry {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  price?: ModelPrice;
  free: boolean;
  router: boolean;
}

export interface ModelList {
  models: ModelEntry[];
  // True when the provider reports prices, so the panel can offer All/Free.
  pricing: boolean;
  truncated: boolean;
}

// The reason a provider call failed, in words the owner can act on.
export type CallFailure =
  | { kind: "network"; host: string }
  | { kind: "timeout"; host: string }
  | { kind: "status"; status: number }
  | { kind: "format" };

export function failureMessage(failure: CallFailure): string {
  switch (failure.kind) {
    case "network":
      return `Could not reach ${failure.host}. Check the address and that the server is running.`;
    case "timeout":
      return `${failure.host} did not answer in time. Try again in a moment.`;
    case "status":
      if (failure.status === 401 || failure.status === 403)
        return "The provider did not accept this key. Check that you copied the whole key.";
      if (failure.status === 404)
        return "The address did not answer like a model list. For a custom server, the address usually ends in /v1.";
      if (failure.status === 429)
        return "The provider is busy or has no credit left right now. Try again later or check your account.";
      if (failure.status >= 500)
        return "The provider had a problem on its side. Try again later.";
      return `The provider answered with an error (HTTP ${failure.status}).`;
    case "format":
      return "The provider answered, but not in the format homectl expects.";
  }
}

function hostOf(url: string): string {
  return new URL(url).host;
}

function headersFor(
  protocol: ReviewerProtocol,
  apiKey: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (protocol === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    return headers;
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\p{Cc}]/gu, " ").trim();
  return clean.length === 0 ? undefined : clean.slice(0, max);
}

function numberOf(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : (value as unknown);
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

// One entry from the provider's list. Prices come as per-token strings on
// OpenRouter and are scaled to per million tokens.
export function modelEntry(raw: unknown): ModelEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const id = text(item.id, 200);
  if (id === undefined) return undefined;
  const pricing = item.pricing as Record<string, unknown> | undefined;
  const prompt = numberOf(pricing?.prompt);
  const completion = numberOf(pricing?.completion);
  const top = item.top_provider as Record<string, unknown> | undefined;
  const context =
    numberOf(item.context_length) ??
    numberOf(top?.context_length) ??
    numberOf(item.max_input_tokens);
  const price =
    prompt !== undefined && completion !== undefined
      ? {
          promptPerMillion: prompt * 1_000_000,
          completionPerMillion: completion * 1_000_000,
        }
      : undefined;
  const free =
    id.endsWith(":free") ||
    (price !== undefined &&
      price.promptPerMillion === 0 &&
      price.completionPerMillion === 0);
  const entry: ModelEntry = {
    id,
    name: text(item.name, MAX_TEXT) ?? text(item.display_name, MAX_TEXT) ?? id,
    free,
    router: id.startsWith("openrouter/"),
  };
  const description = text(item.description, MAX_TEXT);
  if (description !== undefined) entry.description = description;
  if (context !== undefined) entry.contextLength = Math.round(context);
  if (price !== undefined) entry.price = price;
  return entry;
}

export async function listModels(
  spec: ProviderSpec,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelList> {
  const url =
    spec.protocol === "anthropic-messages"
      ? `${spec.modelsUrl}?limit=100`
      : spec.modelsUrl;
  const host = hostOf(url);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: headersFor(spec.protocol, apiKey),
      redirect: "error",
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new HomectlError(
      5,
      failureMessage(
        timedOut ? { kind: "timeout", host } : { kind: "network", host },
      ),
    );
  }
  if (!response.ok)
    throw new HomectlError(
      5,
      failureMessage({ kind: "status", status: response.status }),
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HomectlError(5, failureMessage({ kind: "format" }));
  }
  const data =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as unknown[])
      : undefined;
  if (data === undefined)
    throw new HomectlError(5, failureMessage({ kind: "format" }));
  const models: ModelEntry[] = [];
  for (const raw of data) {
    const entry = modelEntry(raw);
    if (entry !== undefined) models.push(entry);
    if (models.length >= MAX_MODELS) break;
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return {
    models,
    pricing: models.some((model) => model.price !== undefined),
    truncated: data.length > models.length,
  };
}

// A harmless review of a made-up request. It proves the address, the key and
// the model work together and that the answer has the expected shape. Nothing
// runs and nothing is approved.
export async function testReviewer(
  spec: ProviderSpec,
  model: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ verdict: string }> {
  const reviewer = httpReviewer({
    url: spec.chatUrl,
    model,
    protocol: spec.protocol,
    getApiKey: async () => apiKey,
    fetchImpl,
  });
  const host = hostOf(spec.chatUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const answer = await reviewer.review(
      {
        kind: "exec",
        host: "test-host",
        argv: ["uname", "-s"],
        classification: "inspect",
        risk: "R1",
      },
      controller.signal,
    );
    const output = parseReviewerOutput(answer);
    if (output === null)
      throw new HomectlError(5, failureMessage({ kind: "format" }));
    return { verdict: output.verdict };
  } catch (error) {
    if (error instanceof HomectlError) throw error;
    throw new HomectlError(
      5,
      failureMessage(callFailureOf(error, host, controller.signal.aborted)),
    );
  } finally {
    clearTimeout(timer);
  }
}

// Maps the adapter's failure to a call failure. A plain fetch error is taken
// as a network problem; a body that does not parse is a format problem.
export function callFailureOf(
  error: unknown,
  host: string,
  timedOut: boolean,
): CallFailure {
  if (timedOut) return { kind: "timeout", host };
  if (error instanceof ReviewerRequestError) {
    if (error.reason === "status")
      return { kind: "status", status: error.status ?? 0 };
    if (error.reason === "format") return { kind: "format" };
    return { kind: "network", host };
  }
  return { kind: "format" };
}
