// Browser side of the AI helper onboarding (0.3). The panel never calls a
// provider: the broker lists models and runs the test. The key typed here is
// sent once, during onboarding, and is not kept after the flow ends.
import { ownerCall } from "./api";
import {
  type AiProviderId,
  type AutoModeView,
  toAutoModeView,
} from "./auto-mode-api";

export interface ModelPrice {
  promptPerMillion: number;
  completionPerMillion: number;
}

export interface ModelCard {
  id: string;
  name: string;
  description?: string;
  contextLength?: number;
  price?: ModelPrice;
  free: boolean;
  router: boolean;
}

export interface ModelList {
  models: ModelCard[];
  pricing: boolean;
  truncated: boolean;
}

// What the owner entered for the provider. `apiKey` is set only when typed.
export interface ProviderForm {
  provider: AiProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const MAX_MODELS = 300;

function textOf(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function priceOf(value: unknown): ModelPrice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const prompt = raw.promptPerMillion;
  const completion = raw.completionPerMillion;
  return typeof prompt === "number" &&
    typeof completion === "number" &&
    Number.isFinite(prompt) &&
    Number.isFinite(completion)
    ? { promptPerMillion: prompt, completionPerMillion: completion }
    : undefined;
}

function cardOf(value: unknown): ModelCard | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const id = textOf(raw.id, 200);
  if (id === undefined) return undefined;
  const card: ModelCard = {
    id,
    name: textOf(raw.name, 200) ?? id,
    free: raw.free === true,
    router: raw.router === true,
  };
  const description = textOf(raw.description, 200);
  if (description !== undefined) card.description = description;
  if (typeof raw.contextLength === "number" && raw.contextLength > 0)
    card.contextLength = raw.contextLength;
  const price = priceOf(raw.price);
  if (price !== undefined) card.price = price;
  return card;
}

// Accepts only the documented shape. Anything else is an unreadable answer.
export function toModelList(value: unknown): ModelList | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.models)) return undefined;
  const models = raw.models
    .map(cardOf)
    .filter((card): card is ModelCard => card !== undefined)
    .slice(0, MAX_MODELS);
  return {
    models,
    pricing: raw.pricing === true,
    truncated: raw.truncated === true,
  };
}

// The fields every provider call shares. The key is included only when typed.
function providerBody(form: ProviderForm): Record<string, unknown> {
  return {
    provider: form.provider,
    ...(form.provider === "custom" ? { baseUrl: form.baseUrl.trim() } : {}),
    ...(form.apiKey.length > 0 ? { apiKey: form.apiKey } : {}),
  };
}

export async function listAiModels(form: ProviderForm): Promise<ModelList> {
  const list = toModelList(
    await ownerCall<unknown>("/v1/owner/ai-helper/models", providerBody(form)),
  );
  if (list === undefined)
    throw new Error("The AI helper sent a model list the panel cannot read.");
  return list;
}

// Resolves when the broker's harmless test review worked; throws with the
// broker's plain sentence otherwise.
export async function testAiHelper(form: ProviderForm): Promise<void> {
  await ownerCall<unknown>("/v1/owner/ai-helper/test", {
    ...providerBody(form),
    model: form.model,
  });
}

export interface ConnectRequest extends ProviderForm {
  // Undefined for "Connect AI helper" under Advanced: the mode stays as it is.
  preset?: "routine" | "delegated";
  password: string;
}

// Saves the mode, the provider settings and the key in one request.
export async function connectAiHelper(
  request: ConnectRequest,
): Promise<AutoModeView> {
  const view = toAutoModeView(
    await ownerCall<unknown>("/v1/owner/ai-helper/connect", {
      ...providerBody(request),
      model: request.model,
      password: request.password,
      ...(request.preset === undefined ? {} : { preset: request.preset }),
    }),
  );
  if (view === undefined)
    throw new Error("The AI helper sent a status the panel cannot read.");
  return view;
}

export async function forgetAiKey(password: string): Promise<AutoModeView> {
  const view = toAutoModeView(
    await ownerCall<unknown>("/v1/owner/ai-helper/forget-key", { password }),
  );
  if (view === undefined)
    throw new Error("The AI helper sent a status the panel cannot read.");
  return view;
}
