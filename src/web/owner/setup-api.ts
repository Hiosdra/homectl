// Browser side of the guided setup. The broker keeps the progress (broker/setup.json)
// and detects the real state; this module only reads that status and sends marks.
// Nothing here is stored in the browser, and no token or secret is ever sent.
import { ownerCall, ownerRead } from "./api";

export type SetupStepId =
  | "vault"
  | "machine"
  | "assistant"
  | "first-request"
  | "permissions"
  | "devices"
  | "notifications";

export type StepState = "done" | "skipped" | "open";

// How the owner is guided: step by step here, or by their AI agent.
export type SetupPath = "manual" | "agent";

export interface SetupStep {
  id: SetupStepId;
  required: boolean;
  detected: boolean;
  stored: { status: "done" | "skipped"; at: number } | null;
  state: StepState;
}

export interface SetupFacts {
  vault: boolean;
  machines: number;
  readyMachines: number;
  assistants: number;
  connectedAssistants: number;
  requests: number;
  firstRequestAt?: number;
  resolvedApprovals: number;
  permissionsRevision: number;
  workspaceServer: boolean;
  pairedDevices: number;
}

export interface SetupStatus {
  welcomed: boolean;
  completed: boolean;
  dismissed: boolean;
  // null until the owner picks a path on Welcome.
  path: SetupPath | null;
  upgrade?: { at: number; acknowledged: boolean };
  steps: SetupStep[];
  next: SetupStepId | null;
  counts: {
    required: number;
    requiredDone: number;
    optional: number;
    optionalDone: number;
  };
  facts: SetupFacts;
}

// What the panel may send. The broker refuses anything outside these pairs.
export type SetupMark =
  | { action: "welcome" }
  | { action: "upgrade-ack" }
  | { action: "dismiss" }
  | { action: "path"; path: SetupPath }
  | { action: "skip" | "reopen" | "keep" | "done"; step: SetupStepId };

export function readSetup(): Promise<SetupStatus> {
  return ownerRead<SetupStatus>("/v1/owner/setup");
}

export function markSetup(mark: SetupMark): Promise<SetupStatus> {
  return ownerCall<SetupStatus>("/v1/owner/setup/step", { ...mark });
}

export function stepOf(status: SetupStatus, id: SetupStepId): SetupStep {
  const found = status.steps.find((step) => step.id === id);
  // The broker lists every step, so a miss means an older broker: treat as open.
  return (
    found ?? {
      id,
      required: true,
      detected: false,
      stored: null,
      state: "open",
    }
  );
}
