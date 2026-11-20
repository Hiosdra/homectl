// Owner routes for the AI helper onboarding (0.3). The browser sends a provider,
// a Custom address and, only during onboarding, the key the owner typed. The
// broker calls the provider; nothing returns the key. Connect saves the mode,
// the provider settings and the key together, behind the owner password.
// Forget removes the saved key, also behind the password. Every step that
// writes waits for the password before anything changes.
import { type Preset, defaultPolicy } from "../authz";
import type { PolicyDocument } from "../core/contracts";
import { HomectlError } from "../types";
import { autoModeView, endpointOrigin } from "./auto-mode";
import { listModels, testReviewer } from "./ai-models";
import {
  type AiProvider,
  isAiProvider,
  normalizeBaseUrl,
  policyProviderId,
  providerSpec,
  type ProviderSpec,
} from "./ai-providers";
import type { PolicyDocumentStore } from "./policy-routes";
import {
  keyStatus,
  type KeyStatus,
  type ReviewerKeyStore,
  reviewerApiKey,
} from "./reviewer-key";
import {
  loadReviewerSettings,
  normalizeModel,
  type ReviewerSettings,
  saveReviewerSettings,
} from "./reviewer-settings";
import type { RouteExtension } from "./server";
import type { EventsPort } from "./types";

const PRESETS: readonly Preset[] = ["conservative", "routine", "delegated"];
const KEY_MAX = 500;

export interface AiHelperRoutesOptions {
  store: PolicyDocumentStore;
  settingsPath: string;
  env: Record<string, string | undefined>;
  keys: ReviewerKeyStore;
  events?: EventsPort;
  fetchImpl?: typeof fetch;
}

interface ProviderRequest {
  provider: AiProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// Only fields the onboarding sends are accepted; anything else is refused.
function refuseUnknown(input: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(input))
    if (!allowed.includes(key))
      throw new HomectlError(2, `Unknown field: ${key}`);
}

// A key the owner typed. Trimmed; must not contain spaces or control
// characters, which a pasted key never has. Never echoed back in an error.
export function parseApiKey(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string")
    throw new HomectlError(2, "The key must be text");
  const key = raw.trim();
  if (key.length > KEY_MAX)
    throw new HomectlError(2, "That key is too long. Paste only the key.");
  if (/[\p{Cc}\s]/u.test(key))
    throw new HomectlError(
      2,
      "The key has spaces or line breaks. Paste only the key.",
    );
  return key.length > 0 ? key : undefined;
}

function parseProviderRequest(
  input: Record<string, unknown>,
  allowed: string[],
): ProviderRequest {
  refuseUnknown(input, allowed);
  if (!isAiProvider(input.provider))
    throw new HomectlError(
      2,
      "Choose a provider: anthropic, openai, openrouter or custom",
    );
  const request: ProviderRequest = { provider: input.provider };
  if (input.provider === "custom") {
    request.baseUrl = normalizeBaseUrl(input.baseUrl);
  }
  const apiKey = parseApiKey(input.apiKey);
  if (apiKey !== undefined) request.apiKey = apiKey;
  if (input.model !== undefined) request.model = normalizeModel(input.model);
  return request;
}

export class AiHelperRoutes implements RouteExtension {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AiHelperRoutesOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    switch (path) {
      case "/v1/owner/ai-helper/models":
        return this.models(
          parseProviderRequest(input, ["provider", "baseUrl", "apiKey"]),
        );
      case "/v1/owner/ai-helper/test":
        return this.test(
          parseProviderRequest(input, [
            "provider",
            "baseUrl",
            "apiKey",
            "model",
          ]),
        );
      case "/v1/owner/ai-helper/connect":
        return this.connect(input, stepUp);
      case "/v1/owner/ai-helper/forget-key":
        return this.forgetKey(input, stepUp);
      default:
        return undefined;
    }
  }

  // The key for one call: the one typed during onboarding, else the environment
  // or the vault. A hosted provider with no key stops here, plainly.
  private async keyFor(
    request: ProviderRequest,
    spec: ProviderSpec,
  ): Promise<string | undefined> {
    const key =
      request.apiKey ??
      (await reviewerApiKey(this.options.env, this.options.keys));
    if (key === undefined && spec.keyRequired)
      throw new HomectlError(
        2,
        "Add the API key first. It is saved in the encrypted vault and never shown again.",
      );
    return key;
  }

  private async models(request: ProviderRequest) {
    const spec = providerSpec(request.provider, request.baseUrl);
    const key = await this.keyFor(request, spec);
    return listModels(spec, key, this.fetchImpl);
  }

  private async test(request: ProviderRequest) {
    if (request.model === undefined)
      throw new HomectlError(2, "Choose a model first");
    const spec = providerSpec(request.provider, request.baseUrl);
    const key = await this.keyFor(request, spec);
    await testReviewer(spec, request.model, key, this.fetchImpl);
    return { ready: true };
  }

  // The current key source for the view. Never the key.
  keySource(): KeyStatus {
    const { env, keys } = this.options;
    return keyStatus(env, keys);
  }

  private view(doc: PolicyDocument, settings: ReviewerSettings) {
    return autoModeView(doc, settings, this.keySource());
  }

  private async connect(
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ) {
    const request = parseProviderRequest(input, [
      "preset",
      "provider",
      "baseUrl",
      "apiKey",
      "model",
      "password",
    ]);
    if (request.model === undefined)
      throw new HomectlError(2, "Choose a model first");
    const preset =
      input.preset === undefined ? undefined : presetOf(input.preset);
    const spec = providerSpec(request.provider, request.baseUrl);
    // The owner password comes first: it also opens a locked vault, so the
    // key check below can read it. Nothing is written before this passes.
    await stepUp(input.password);
    if (request.apiKey === undefined && spec.keyRequired)
      await this.keyFor(request, spec);
    if (request.apiKey !== undefined)
      await this.options.keys.save(request.apiKey);
    const doc = await this.options.store.document();
    const target =
      preset === undefined ? undefined : defaultPolicy(preset, Date.now());
    const next: PolicyDocument = {
      ...doc,
      ...(target ? { mode: target.mode } : {}),
      reviewer: {
        ...doc.reviewer,
        ...(target ? { authority: target.reviewer.authority } : {}),
        provider: policyProviderId(request.provider),
      },
    };
    const settings: ReviewerSettings = {
      version: 1,
      provider: request.provider,
      endpoint: spec.chatUrl,
      model: request.model,
    };
    const saved = await this.options.store.save(next);
    await saveReviewerSettings(this.options.settingsPath, settings);
    await this.options.events?.emit(
      "settings.updated",
      "ai-helper",
      ["owner"],
      {
        policyRevision: saved.revision,
        mode: saved.mode,
        authority: saved.reviewer.authority,
        provider: request.provider,
        endpoint: endpointOrigin(settings),
        keyChanged: request.apiKey !== undefined,
        stepUp: true,
      },
    );
    return this.view(saved, settings);
  }

  private async forgetKey(
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ) {
    refuseUnknown(input, ["password"]);
    await stepUp(input.password);
    await this.options.keys.remove();
    const doc = await this.options.store.document();
    const settings = await loadReviewerSettings(this.options.settingsPath);
    await this.options.events?.emit(
      "settings.updated",
      "ai-helper",
      ["owner"],
      {
        policyRevision: doc.revision,
        keyRemoved: true,
        stepUp: true,
      },
    );
    return this.view(doc, settings);
  }
}

function presetOf(value: unknown): Preset {
  if (typeof value !== "string" || !PRESETS.includes(value as Preset))
    throw new HomectlError(2, "Unknown preset");
  return value as Preset;
}
