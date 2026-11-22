// What an agent may read of the guided setup (0.3 acceptance). The agent sees step
// states, who has to act on each step, and the machines its own grant covers, with
// their access level and check result. It never sees addresses, keys, probe error
// text, the owner's sign-in or any setup fact beyond these. Reads only: nothing here
// changes setup or security state, and nothing here is a way to pass an owner step.
import type { Risk } from "../core/contracts";
import type { SetupStatus, StepState } from "./setup-detect";
import {
  SETUP_REQUESTS,
  SETUP_SPECS,
  type SetupRequestKind,
} from "./setup-request";
import type { SetupPath, SetupStepId } from "./setup-state";

// Who has to act on each step. "agent" steps are work the assistant does through
// homectl (its own requests, which the owner approves in Needs you). "owner" steps
// need the owner at the homectl panel or in a private terminal: they need the owner
// password, the owner's typed fingerprint, or a key only the owner may make.
export const STEP_OWNER: Record<SetupStepId, "agent" | "owner"> = {
  vault: "owner",
  machine: "owner",
  assistant: "owner",
  "first-request": "agent",
  permissions: "owner",
  devices: "owner",
  notifications: "owner",
};

export interface AgentSetupStep {
  id: SetupStepId;
  required: boolean;
  state: StepState;
  who: "agent" | "owner";
}

// A request this agent may make now. Each one waits for the owner in Needs you.
export interface AgentRequest {
  kind: SetupRequestKind;
  label: string;
  risk: Risk;
  approval: string;
}

export interface AgentSetupStatus {
  path: SetupPath | null;
  completed: boolean;
  next: SetupStepId | null;
  counts: SetupStatus["counts"];
  steps: AgentSetupStep[];
  // The setup requests the agent can make (owner approves each one in Needs you).
  requests: AgentRequest[];
  // What only the owner can do, in plain words. The agent points the owner here.
  ownerOnly: string[];
  // Plain words for the agent: what it may do and what it must hand back.
  ownerNote: string;
}

export const OWNER_NOTE =
  "Steps marked owner belong to the owner. Tell them what to do in the homectl panel and wait: do not ask for the owner password, the vault password or any key, and do not try to make a change those steps need. Steps marked agent are yours: make your requests through homectl (the requests list) and wait for the owner to approve each one in Needs you. Then poll its status until it is final.";

// Owner-only, in plain words. None of these can be requested: the agent is told
// to point the owner at the panel instead.
export const OWNER_ONLY_STEPS: readonly string[] = [
  "Create or unlock the vault and set the owner password",
  "Store the AI helper key",
  "Make a machine's key in your private terminal (home-ctl key create NAME)",
  "Confirm a new machine's fingerprint: type it from the card, then your password",
  "Restore a backup",
  "Pair devices and turn on notifications in the panel",
];

function approvalText(kind: SetupRequestKind): string {
  const spec = SETUP_SPECS[kind];
  if (kind === "enroll")
    return "Owner approves with the password and the typed fingerprint";
  return spec.password
    ? "Owner approves with the password"
    : "Owner approves; no password";
}

export const AGENT_REQUESTS: readonly AgentRequest[] = SETUP_REQUESTS.map(
  (kind) => ({
    kind,
    label: SETUP_SPECS[kind].label,
    risk: SETUP_SPECS[kind].risk,
    approval: approvalText(kind),
  }),
);

export function agentSetupStatus(status: SetupStatus): AgentSetupStatus {
  return {
    path: status.path,
    completed: status.completed,
    next: status.next,
    counts: status.counts,
    steps: status.steps.map((step) => ({
      id: step.id,
      required: step.required,
      state: step.state,
      who: STEP_OWNER[step.id],
    })),
    requests: [...AGENT_REQUESTS],
    ownerOnly: [...OWNER_ONLY_STEPS],
    ownerNote: OWNER_NOTE,
  };
}

// One machine as the agent may see it. `ready` means pinned and the last check passed.
export interface MachineSummary {
  name: string;
  access: string;
  pinned: boolean;
  ready: boolean;
}

// The shape the owner's machine list gives (owner-hosts.ts). Only these fields are read.
export interface MachineListRow {
  name: string;
  access: string;
  pinned: unknown;
  probe: { ok: boolean } | null;
}

export function machineSummaries(rows: MachineListRow[]): MachineSummary[] {
  return rows.map((row) => ({
    name: row.name,
    access: row.access,
    pinned: row.pinned !== null && row.pinned !== undefined,
    ready:
      row.pinned !== null && row.pinned !== undefined && row.probe?.ok === true,
  }));
}

// Only the machines the agent's own grant names. An agent with no grant sees none.
export function grantedMachines(
  machines: MachineSummary[],
  hosts: string[],
): MachineSummary[] {
  return machines
    .filter((machine) => hosts.includes(machine.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
