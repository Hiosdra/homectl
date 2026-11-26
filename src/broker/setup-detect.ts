// Detection and the setup status the panel reads (audit C1, C3). Pure: the broker
// gathers the facts (setup-facts.ts) and this module decides what they mean. A step
// that is detected is done, whatever was stored; a stored skip or a stored "keep
// this" only matters while the real state has not caught up.
import {
  REQUIRED_STEPS,
  SETUP_STEPS,
  type SetupFile,
  type SetupPath,
  type SetupStepId,
  type StoredStep,
} from "./setup-state";

// Counts and booleans only. Nothing here names a key, an address or a secret.
export interface SetupFacts {
  vault: boolean;
  // Enrolled machines, and those pinned and probed OK.
  machines: number;
  readyMachines: number;
  // Active (not revoked) assistants, and those that have reached the broker.
  assistants: number;
  connectedAssistants: number;
  // Operations seen, the earliest time, and approvals resolved (approved or denied).
  requests: number;
  firstRequestAt?: number;
  resolvedApprovals: number;
  permissionsRevision: number;
  workspaceServer: boolean;
  pairedDevices: number;
}

export function detectSteps(facts: SetupFacts): Record<SetupStepId, boolean> {
  return {
    vault: facts.vault,
    machine: facts.machines > 0 || facts.readyMachines > 0,
    assistant: facts.connectedAssistants > 0,
    "first-request": facts.requests > 0 && facts.resolvedApprovals > 0,
    // Saved changes bump the policy revision from 0. "Keep this" is a stored mark.
    permissions: facts.permissionsRevision > 0,
    devices: facts.workspaceServer || facts.pairedDevices > 0,
    // The browser's notification permission is read in the panel, not here.
    notifications: false,
  };
}

export type StepState = "done" | "skipped" | "open";

export interface StepStatus {
  id: SetupStepId;
  required: boolean;
  detected: boolean;
  stored: StoredStep | null;
  // Detected wins; otherwise the stored mark; otherwise open.
  state: StepState;
}

export interface SetupStatus {
  welcomed: boolean;
  welcomedAt?: number;
  completed: boolean;
  completedAt?: number;
  dismissed: boolean;
  // The owner's chosen path, or null before the owner has picked one.
  path: SetupPath | null;
  upgrade?: { at: number; acknowledged: boolean };
  steps: StepStatus[];
  // The first required step not done, which "Continue setup" opens.
  next: SetupStepId | null;
  counts: {
    required: number;
    requiredDone: number;
    optional: number;
    optionalDone: number;
  };
  facts: SetupFacts;
}

export function buildStatus(file: SetupFile, facts: SetupFacts): SetupStatus {
  const detected = detectSteps(facts);
  const steps: StepStatus[] = SETUP_STEPS.map((id) => {
    const stored = file.steps[id] ?? null;
    const isDetected = detected[id];
    const state: StepState = isDetected ? "done" : (stored?.status ?? "open");
    return {
      id,
      required: REQUIRED_STEPS.includes(id),
      detected: isDetected,
      stored,
      state:
        state === "done" ? "done" : state === "skipped" ? "skipped" : "open",
    };
  });
  const required = steps.filter((step) => step.required);
  const optional = steps.filter((step) => !step.required);
  const requiredDone = required.filter((step) => step.state === "done").length;
  const optionalDone = optional.filter((step) => step.state === "done").length;
  const completed = requiredDone === required.length;
  const next =
    required.find((step) => step.state !== "done")?.id ??
    optional.find((step) => step.state === "open")?.id ??
    null;
  return {
    welcomed: file.welcomedAt !== undefined,
    ...(file.welcomedAt === undefined ? {} : { welcomedAt: file.welcomedAt }),
    completed,
    ...(file.completedAt === undefined
      ? {}
      : { completedAt: file.completedAt }),
    dismissed: file.dismissedAt !== undefined,
    path: file.setupPath ?? null,
    ...(file.upgradedAt === undefined
      ? {}
      : {
          upgrade: {
            at: file.upgradedAt,
            acknowledged: file.upgradeAckAt !== undefined,
          },
        }),
    steps,
    next,
    counts: {
      required: required.length,
      requiredDone,
      optional: optional.length,
      optionalDone,
    },
    facts,
  };
}
