// The AI helper's providers (0.3 onboarding). The broker talks to the provider;
// the browser never does. Each provider has a fixed chat address and a model
// list address. Custom takes a base address from the owner (Ollama, LM Studio
// or any OpenAI-compatible server) and works without a key.
import { HomectlError } from "../types";
import type { ReviewerProtocol } from "../authz/http-reviewer";
import { parseEndpoint } from "../authz/http-reviewer";

export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "custom",
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface ProviderSpec {
  id: AiProvider;
  protocol: ReviewerProtocol;
  // Full address the reviewer posts to.
  chatUrl: string;
  // Full address that lists the models the provider offers.
  modelsUrl: string;
  keyRequired: boolean;
  // Only Anthropic has a default; for the others the owner picks a model.
  defaultModel?: string;
}

export function isAiProvider(value: unknown): value is AiProvider {
  return (
    typeof value === "string" &&
    (AI_PROVIDERS as readonly string[]).includes(value)
  );
}

// The owner's base address for Custom, without a trailing slash or the chat
// path. Credentials are refused, as they are for the endpoint.
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 500)
    throw new HomectlError(2, "Enter the address of your AI server");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HomectlError(
      2,
      "That address is not valid. It should look like http://localhost:11434/v1",
    );
  }
  if (url.username !== "" || url.password !== "")
    throw new HomectlError(
      2,
      "The address must not contain a username or password",
    );
  url.search = "";
  url.hash = "";
  const root = url.href
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/+$/, "");
  parseEndpoint(root);
  return root;
}

export function providerSpec(
  provider: AiProvider,
  baseUrl?: string,
): ProviderSpec {
  switch (provider) {
    case "anthropic":
      return {
        id: provider,
        protocol: "anthropic-messages",
        chatUrl: "https://api.anthropic.com/v1/messages",
        modelsUrl: "https://api.anthropic.com/v1/models",
        keyRequired: true,
        defaultModel: "claude-haiku-5-5",
      };
    case "openai":
      return {
        id: provider,
        protocol: "openai-chat",
        chatUrl: "https://api.openai.com/v1/chat/completions",
        modelsUrl: "https://api.openai.com/v1/models",
        keyRequired: true,
      };
    case "openrouter":
      return {
        id: provider,
        protocol: "openai-chat",
        chatUrl: "https://openrouter.ai/api/v1/chat/completions",
        modelsUrl: "https://openrouter.ai/api/v1/models",
        keyRequired: true,
      };
    case "custom": {
      if (baseUrl === undefined)
        throw new HomectlError(2, "Enter the address of your AI server");
      const root = normalizeBaseUrl(baseUrl);
      return {
        id: provider,
        protocol: "openai-chat",
        chatUrl: `${root}/chat/completions`,
        modelsUrl: `${root}/models`,
        keyRequired: false,
      };
    }
  }
}

// The policy's adapter id: Anthropic has its own; the others share the
// OpenAI-compatible adapter.
export function policyProviderId(provider: AiProvider): string {
  return provider === "anthropic" ? "anthropic" : "openai-compatible";
}
