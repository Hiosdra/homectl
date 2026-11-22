// Agent requests for the setup write steps (0.3 acceptance). An agent may ask for
// six things: look for a machine's key, check a machine, add a machine, change a
// machine's access level, choose the permission setting, or remove a machine. Each
// request is planned here and waits for the owner in Needs you; it runs only after
// the owner approves it. Every one is a hard-gated owner decision: no AI helper,
// rule or "remember" can approve it. The agent never supplies a password, a typed
// fingerprint or a key; those fields are refused as unknown.
import { fingerprint } from "../control/canonical";
import { hasScope, permitsHost } from "../control/clients";
import type { ClientIdentity } from "../control/types";
import type { Classification, Risk } from "../core/contracts";
import { type Access, HomectlError, type Machine } from "../types";
import {
  checkAccess,
  checkAddress,
  checkLogin,
  checkName,
  checkPort,
} from "./owner-hosts-input";
import type { OperationBase } from "./submit";
import type {
  BrokerOperation,
  InventoryPort,
  PresentedKey,
  SetupPort,
} from "./types";

export const SETUP_REQUESTS = [
  "scan",
  "probe",
  "enroll",
  "access",
  "preset",
  "remove",
] as const;
export type SetupRequestKind = (typeof SETUP_REQUESTS)[number];

export function isSetupRequestKind(value: unknown): value is SetupRequestKind {
  return SETUP_REQUESTS.includes(value as SetupRequestKind);
}

export interface SetupRequestSpec {
  // What the request does, in plain words (the owner and the agent both read it).
  label: string;
  risk: Risk;
  // The owner's password is asked in the approval.
  password: boolean;
  classification: Classification;
  area: string;
}

export const SETUP_SPECS: Record<SetupRequestKind, SetupRequestSpec> = {
  scan: {
    label: "Look for a machine's SSH key",
    risk: "R1",
    password: false,
    classification: "inspect",
    area: "Machines",
  },
  probe: {
    label: "Check that a machine answers",
    risk: "R1",
    password: false,
    classification: "inspect",
    area: "Machines",
  },
  enroll: {
    label: "Add a machine to homectl",
    risk: "R4",
    password: true,
    classification: "mutation",
    area: "Machines",
  },
  access: {
    label: "Change a machine's access level",
    risk: "R3",
    password: true,
    classification: "mutation",
    area: "Machines",
  },
  preset: {
    label: "Change the AI permission setting",
    risk: "R3",
    password: true,
    classification: "mutation",
    area: "Permissions",
  },
  remove: {
    label: "Remove a machine from homectl",
    risk: "R4",
    password: true,
    classification: "destructive",
    area: "Machines",
  },
};

// The permission settings an agent may ask for (the owner's own presets).
export const REQUESTABLE_PRESETS = ["conservative", "routine", "delegated"];

// The fields each request accepts. Anything else is refused by name, so a typed
// fingerprint, a password or a key cannot ride along.
const FIELDS: Record<SetupRequestKind, readonly string[]> = {
  scan: ["address", "port", "narrative"],
  probe: ["name", "narrative"],
  enroll: ["name", "address", "port", "user", "access", "narrative"],
  access: ["name", "access", "narrative"],
  preset: ["preset", "narrative"],
  remove: ["name", "narrative"],
};

// Agents may propose these levels. Admin with your approval needs an allowed-command
// list, which only the owner sets in the panel.
const AGENT_ACCESS = ["observe", "user", "full"];

const NOT_GRANTED = "Host is not in this client's grants";

// The validated request. Only fields from FIELDS survive, each checked.
export interface SetupInput {
  name?: string;
  address?: string;
  port?: number;
  user?: string;
  access?: Access;
  preset?: string;
  narrative?: string;
}

export function validateSetupInput(
  kind: SetupRequestKind,
  raw: unknown,
): SetupInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new HomectlError(2, "Request must be a JSON object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!FIELDS[kind].includes(key))
      throw new HomectlError(2, `Unknown field: ${key}`);
  const out: SetupInput = {};
  if (input.name !== undefined) out.name = checkName(input.name);
  if (input.address !== undefined) out.address = checkAddress(input.address);
  if (input.port !== undefined) out.port = checkPort(input.port);
  if (input.user !== undefined) out.user = checkLogin(input.user);
  if (input.access !== undefined) {
    if (!AGENT_ACCESS.includes(input.access as string))
      throw new HomectlError(
        2,
        "Ask for look only, everyday account or full admin. Admin with your approval is set by the owner in the panel.",
      );
    out.access = checkAccess(input.access);
  }
  if (input.preset !== undefined) {
    if (!REQUESTABLE_PRESETS.includes(input.preset as string))
      throw new HomectlError(2, "Unknown permission setting");
    out.preset = input.preset as string;
  }
  if (input.narrative !== undefined) {
    if (typeof input.narrative !== "string" || input.narrative.length > 2000)
      throw new HomectlError(2, "narrative must be text up to 2000 characters");
    out.narrative = input.narrative;
  }
  const required: Record<SetupRequestKind, (keyof SetupInput)[]> = {
    scan: ["address"],
    probe: ["name"],
    enroll: ["name", "address", "user", "access"],
    access: ["name", "access"],
    preset: ["preset"],
    remove: ["name"],
  };
  for (const field of required[kind])
    if (out[field] === undefined)
      throw new HomectlError(2, `${field} is required for this request`);
  return out;
}

// What the owner approves and the engine keeps: the validated request, and for
// an enrolment the key the machine presented when the request was made.
export interface SetupOperation {
  kind: SetupRequestKind;
  input: Omit<SetupInput, "narrative">;
  presented?: PresentedKey[];
  // The fingerprint the owner typed on the approval card (enrolment only).
  confirmed?: string;
}

// Owner-only: every setup request is a hard-gate decision. The password is asked
// only where the spec says so; scans and checks need no password.
export function setupDecision(
  spec: SetupRequestSpec,
  revision: number,
): BrokerOperation["decision"] {
  return {
    verdict: "ask",
    source: "hard-gate",
    reason: "Only the owner can approve this kind of request",
    humanOnly: true,
    stepUp: spec.password,
    policyRevision: revision,
    modelCalls: 0,
  };
}

export interface SetupPlanContext {
  port: SetupPort | undefined;
  inventory: InventoryPort;
  revision: number;
}

export interface PlannedSetup {
  base: OperationBase;
  decision: BrokerOperation["decision"];
  narrative?: string;
}

// Risk follows the request. Full access is the highest tier, so it is R4 and
// hard-gated like removal; lower tiers are R3.
function riskOf(kind: SetupRequestKind, input: SetupInput): Risk {
  if (kind === "access" && input.access === "full") return "R4";
  return SETUP_SPECS[kind].risk;
}

// Plans one request: checks the client's grant and the request, reads what the
// owner will need to see (the presented key for an enrolment), and returns the
// record to queue. Refusals happen before anything is queued.
export async function planSetupRequest(
  ctx: SetupPlanContext,
  client: ClientIdentity,
  kind: string,
  raw: unknown,
): Promise<PlannedSetup> {
  if (!isSetupRequestKind(kind))
    throw new HomectlError(2, "Unknown setup request");
  const port = ctx.port;
  if (!port)
    throw new HomectlError(
      5,
      "Setup requests are not available on this broker",
    );
  const input = validateSetupInput(kind, raw);
  if (!hasScope(client, "plan:create")) throw new HomectlError(3, NOT_GRANTED);
  const spec = SETUP_SPECS[kind];
  let machine: Machine | undefined;
  if (kind === "probe" || kind === "access" || kind === "remove") {
    const name = input.name ?? "";
    if (!permitsHost(client, name)) throw new HomectlError(3, NOT_GRANTED);
    machine = await ctx.inventory.machine(name);
    if (!machine) throw new HomectlError(3, NOT_GRANTED);
  }
  if (kind === "access") {
    if (machine?.user === "root" && input.access !== "full")
      throw new HomectlError(
        2,
        "The root account always has full access. It cannot be lowered.",
      );
    if (machine?.access === input.access)
      throw new HomectlError(2, "That machine already has this access level");
  }
  let presented: PresentedKey[] | undefined;
  if (kind === "enroll") {
    // The name must be free. The same refusal covers a taken name and a hidden one.
    if (await ctx.inventory.machine(input.name ?? ""))
      throw new HomectlError(3, "That name is already in use");
    presented = await port.presentedKeys(input.address ?? "", input.port ?? 22);
    if (presented.length === 0)
      throw new HomectlError(
        3,
        "That address presented no SSH key, so nothing was queued",
      );
    if (!(await port.keyReady(input.name ?? "")))
      throw new HomectlError(
        2,
        `No key named ${input.name} yet. The owner makes one in a private terminal with: home-ctl key create ${input.name}`,
      );
  }
  const name = input.name ?? input.address ?? input.preset ?? "";
  const risk = riskOf(kind, input);
  const host =
    kind === "scan" ? (input.address ?? "") : kind === "preset" ? "" : name;
  const { narrative, ...stored } = input;
  return {
    base: {
      client: client.id,
      host,
      argv: ["homectl", "setup", kind, name].filter((part) => part !== ""),
      impact: spec.label,
      classification: spec.classification,
      sudo: false,
      risk,
      machineHash: fingerprint(machine ?? null),
      ownerOnly: true,
      area: spec.area,
      setup: {
        kind,
        input: stored,
        ...(presented === undefined ? {} : { presented }),
      },
    },
    decision: setupDecision({ ...spec, risk }, ctx.revision),
    ...(narrative === undefined ? {} : { narrative }),
  };
}
