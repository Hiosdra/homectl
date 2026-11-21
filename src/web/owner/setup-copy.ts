// Plain words for the guided setup (audit B2 and D5). Every line here is what an
// owner reads, so it avoids the developer's terms: the vault password is named once,
// and the technical detail sits behind "Details" on each step.
import type {
  SetupStatus,
  SetupStep,
  SetupStepId,
  StepState,
} from "./setup-api";

export type WizardStepId = "welcome" | SetupStepId | "done";

export interface WizardStep {
  id: WizardStepId;
  title: string;
  // One plain sentence under the title.
  line: string;
  required: boolean;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: "welcome",
    title: "Welcome",
    line: "homectl lets an AI assistant work on your machines. You decide what it may change. It takes about 15 minutes, and you can stop and come back.",
    required: false,
  },
  {
    id: "vault",
    title: "Vault and sign-in",
    line: "Your vault keeps your machines' keys. Its password is also how you sign in here.",
    required: true,
  },
  {
    id: "machine",
    title: "Add your first machine",
    line: "Name it, give its address and login name, and choose what homectl may do there. Nothing is trusted until you have checked it.",
    required: true,
  },
  {
    id: "assistant",
    title: "Connect an assistant",
    line: "Give Claude or Codex its own key. It can only reach the machines you pick.",
    required: true,
  },
  {
    id: "first-request",
    title: "First safe request",
    line: "Ask your assistant for something read-only, then a small change. You approve the change.",
    required: true,
  },
  {
    id: "permissions",
    title: "Choose how much homectl decides",
    line: "Decide how much homectl may do on its own. “Ask me first” is the default: every change waits for you.",
    required: true,
  },
  {
    id: "devices",
    title: "Second device and backups",
    line: "Pair another computer and keep an encrypted copy of your vault. Optional.",
    required: false,
  },
  {
    id: "notifications",
    title: "Notifications and updates",
    line: "Get an alert when a request needs you, see when a new version is out, and optionally start homectl when you sign in. Optional.",
    required: false,
  },
  {
    id: "done",
    title: "You're set up",
    line: "homectl is set up. Requests that need you appear in Needs you.",
    required: false,
  },
];

export const STEP_IDS: readonly WizardStepId[] = WIZARD_STEPS.map(
  (step) => step.id,
);

export function wizardStep(id: string): WizardStep | undefined {
  return WIZARD_STEPS.find((step) => step.id === id);
}

// The four state words the checklist shows, plus "To do" for a required step that
// is open but not the next one.
export function stateWord(step: SetupStep, next: SetupStepId | null): string {
  if (step.state === "done") return "Done";
  if (step.state === "skipped") return "Skipped";
  if (!step.required) return "Optional";
  return step.id === next ? "Next" : "To do";
}

export function stateTone(state: StepState): "good" | "warn" | "neutral" {
  if (state === "done") return "good";
  if (state === "skipped") return "warn";
  return "neutral";
}

// "2 of 5 needed · 0 of 2 optional"
export function progressLine(status: SetupStatus): string {
  const { required, requiredDone, optional, optionalDone } = status.counts;
  return `${requiredDone} of ${required} needed · ${optionalDone} of ${optional} optional`;
}

// The first step to show when setup is opened without a step.
export function firstOpenStep(status: SetupStatus): WizardStepId {
  if (!status.welcomed) return "welcome";
  if (status.completed) return "done";
  return status.next ?? "done";
}

// Words for an upgrade notice, in plain language. The broker says only when it ran.
export const UPGRADE_TITLE = "homectl updated your saved data";
export const UPGRADE_LINE =
  "Your saved data was moved to this version, and a backup of the old data was kept. Connect each assistant again, so its settings point at this version: open Assistants.";
