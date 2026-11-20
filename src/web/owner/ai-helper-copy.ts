// Plain-language words for the AI helper onboarding. The owner is not expected
// to know what an API, a base address or a model ID is; each term is explained
// in a sentence, and the technical detail stays behind "Details".
import type { AiProviderId, KeySource } from "./auto-mode-api";

export const PROVIDER_CHOICES: {
  id: AiProviderId;
  label: string;
  keyHint: string;
}[] = [
  { id: "anthropic", label: "Anthropic", keyHint: "Starts with sk-ant-…" },
  { id: "openai", label: "OpenAI", keyHint: "Starts with sk-…" },
  { id: "openrouter", label: "OpenRouter", keyHint: "Starts with sk-or-v1-…" },
  { id: "custom", label: "Custom", keyHint: "Optional for most local servers" },
];

export const CUSTOM_BASE_EXAMPLE = "http://localhost:11434/v1";

export function providerLabel(id: AiProviderId | undefined): string {
  return PROVIDER_CHOICES.find((item) => item.id === id)?.label ?? "Not chosen";
}

export const SHEET_TITLE = "Connect your AI helper";
export const SHEET_INTRO =
  "The AI helper answers only the requests you have allowed it to decide. Your key is kept in your encrypted vault. It is never shown again.";

export const PROVIDER_HELP =
  "Pick the company whose AI you have an account with. Custom is for an AI running on this network, such as Ollama or LM Studio.";

export const KEY_HELP = "Paste the key from your provider's website.";

export const CUSTOM_KEY_HELP =
  "Most local servers need no key. Leave this blank unless yours asks for one.";

export const ENVIRONMENT_KEY_NOTE =
  "A key from the broker's environment is in use. You do not need to paste one here.";

export const MODEL_HELP =
  "A model is the AI that answers. Refresh the list to see the ones your provider offers.";

export const LOCKED_NOTE = "Unlock homectl to use the AI helper.";

export const TEST_HELP =
  "A harmless test request is sent through homectl. Nothing runs and nothing is approved.";

export const CONFIRM_HELP =
  "Saving sets the provider, the model, the key and your chosen setting together. Your owner password is needed.";

export const READY_TEXT = "Your AI helper is ready.";

export function keySourceLabel(source: KeySource, locked: boolean): string {
  if (source === "environment") return "From the broker's environment";
  if (source === "vault") return "Saved in your encrypted vault";
  return locked ? "Unlock homectl to check" : "No key saved";
}

export function statusSentence(view: {
  ready: boolean;
  provider?: AiProviderId;
  model?: string;
}): string {
  if (view.ready)
    return `Ready with ${providerLabel(view.provider)}${view.model ? `, model ${view.model}` : ""}.`;
  return "Not set up yet. You decide each request that needs a judgment.";
}
