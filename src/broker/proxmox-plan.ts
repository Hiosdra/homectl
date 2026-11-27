// Broker planning for Proxmox requests (kind "proxmox"). A request is either one
// full-mode API call (method, path, params) or one guest catalogue action. Both
// go through the same checks the control plane uses (proxmox/full.ts and
// proxmox/catalogue.ts); the broker adds only the approval flow. Pure: nothing
// here contacts a host.
import { fingerprint } from "../control/canonical";
import type { Classification, Risk } from "../core/contracts";
import {
  buildProxmoxPlan,
  type ProxmoxInput,
  providerFacts,
} from "../proxmox/catalogue";
import { routeArea } from "../proxmox/areas";
import { fullOperation } from "../proxmox/full";
import type { FullMethod } from "../proxmox/full-route-types";
import { HomectlError, type Machine, type ProviderConfig } from "../types";

export type ProxmoxOperationRequest =
  | {
      api: { method: FullMethod; path: string; params: Record<string, string> };
    }
  | { catalogue: ProxmoxInput; transport?: "ssh" };

// What an agent sends to /v1/proxmox. Exactly one of (method + path) or catalogue.
export interface ProxmoxWireInput {
  host: string;
  method?: string;
  path?: string;
  params?: Record<string, string>;
  catalogue?: ProxmoxInput;
  task?: string;
  narrative?: string;
}

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const TASK_PATTERN = /^tsk_[A-Za-z0-9_-]{8,64}$/;
const METHODS = ["GET", "POST", "PUT", "DELETE"];
const KEYS = new Set([
  "host",
  "method",
  "path",
  "params",
  "catalogue",
  "task",
  "narrative",
]);
const CATALOGUE_KEYS = new Set([
  "kind",
  "action",
  "vmid",
  "template",
  "name",
  "storage",
  "template_storage",
  "memory_mb",
  "swap_mb",
  "cores",
  "disk_gb",
  "bridge",
  "address",
  "cidr",
  "gateway",
  "nesting",
  "keyctl",
  "timeout_s",
]);
const CATALOGUE_NUMBERS = [
  "vmid",
  "memory_mb",
  "swap_mb",
  "cores",
  "disk_gb",
  "cidr",
  "timeout_s",
];
const CATALOGUE_TEXT = [
  "name",
  "storage",
  "template_storage",
  "bridge",
  "address",
  "gateway",
];
const CATALOGUE_ACTIONS = [
  "list",
  "status",
  "config",
  "start",
  "stop",
  "reboot",
  "shutdown",
  "clone",
  "create",
  "destroy",
  "restore",
];

function refuse(message: string, code: 2 | 3 = 2): never {
  throw new HomectlError(code, message);
}

function plainText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validateCatalogue(raw: unknown): ProxmoxInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    refuse("catalogue must be an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!CATALOGUE_KEYS.has(key)) refuse(`Unknown catalogue field: ${key}`);
  if (input.kind !== "qemu" && input.kind !== "lxc")
    refuse("catalogue.kind must be qemu or lxc");
  if (
    typeof input.action !== "string" ||
    !CATALOGUE_ACTIONS.includes(input.action)
  )
    refuse("catalogue.action is not a known guest action");
  for (const key of CATALOGUE_NUMBERS)
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]))
    )
      refuse(`catalogue.${key} must be a whole number`);
  for (const key of CATALOGUE_TEXT)
    if (input[key] !== undefined && !plainText(input[key], 200))
      refuse(`catalogue.${key} must be text of up to 200 characters`);
  for (const key of ["nesting", "keyctl"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      refuse(`catalogue.${key} must be a boolean`);
  if (
    input.template !== undefined &&
    typeof input.template !== "number" &&
    !plainText(input.template, 200)
  )
    refuse("catalogue.template must be a number or text");
  return input as unknown as ProxmoxInput;
}

// Shape checks only. Routes, ranges, protected ids and secrets are checked when
// the request is planned against the provider's facts.
export function validateProxmoxInput(raw: unknown): ProxmoxWireInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    refuse("Request must be a JSON object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!KEYS.has(key)) refuse(`Unknown field: ${key}`);
  const { host, method, path, params, catalogue, task, narrative } = input;
  if (typeof host !== "string" || !HOST_PATTERN.test(host))
    refuse("host must be an inventory host name");
  const apiForm = method !== undefined || path !== undefined;
  if (apiForm === (catalogue !== undefined))
    refuse("Send either method and path, or catalogue, not both");
  if (apiForm) {
    if (typeof method !== "string" || !METHODS.includes(method))
      refuse("method must be GET, POST, PUT or DELETE");
    if (!plainText(path, 300))
      refuse("path must be text of up to 300 characters");
    if (params !== undefined) {
      if (!params || typeof params !== "object" || Array.isArray(params))
        refuse("params must be an object of text values");
      for (const value of Object.values(params))
        if (typeof value !== "string") refuse("params must be text values");
    }
  } else if (params !== undefined) {
    refuse("params go with method and path, not with catalogue");
  }
  if (
    task !== undefined &&
    (typeof task !== "string" || !TASK_PATTERN.test(task))
  )
    refuse("task must be a task id");
  if (
    narrative !== undefined &&
    (typeof narrative !== "string" || narrative.length > 2000)
  )
    refuse("narrative must be text up to 2000 characters");
  return {
    host,
    ...(apiForm
      ? {
          method: method as string,
          path: path as string,
          ...(params === undefined
            ? {}
            : { params: params as Record<string, string> }),
        }
      : { catalogue: validateCatalogue(catalogue) }),
    ...(task === undefined ? {} : { task: task as string }),
    ...(narrative === undefined ? {} : { narrative: narrative as string }),
  };
}

export function riskOfClassification(classification: Classification): Risk {
  switch (classification) {
    case "inspect":
      return "R1";
    case "mutation":
      return "R2";
    case "opaque":
      return "R3";
    case "destructive":
      return "R4";
  }
}

export interface PlannedProxmox {
  request: ProxmoxOperationRequest;
  // Display argv: the inner qm/pct argv for catalogue actions, or
  // ["proxmox-api", METHOD, path] for full-mode calls. Never run over SSH.
  argv: string[];
  impact: string;
  classification: Classification;
  risk: Risk;
  sudo: boolean;
  // Owner-only operations have no approval path but the owner's.
  ownerOnly: boolean;
  area: string;
  providerHash: string;
}

// Plans one request against the provider's facts. Throws on every refusal, so a
// refused request never becomes an operation.
export function planProxmox(
  input: ProxmoxWireInput,
  machine: Machine,
  provider: ProviderConfig | undefined,
): PlannedProxmox {
  if (provider === undefined)
    refuse("This host is not a configured Proxmox provider", 3);
  const facts = providerFacts(provider);
  const providerHash = fingerprint(provider);
  if (input.catalogue !== undefined) {
    if (
      machine.transport !== "ssh" ||
      machine.access !== "full" ||
      machine.auth?.type !== "keepassxc"
    )
      refuse(
        "The Proxmox catalogue needs a full-access SSH host with a managed key",
        3,
      );
    const plan = buildProxmoxPlan(input.catalogue, facts);
    const ownerOnly = input.catalogue.action === "create";
    return {
      request: { catalogue: input.catalogue, transport: "ssh" },
      argv: plan.argv,
      impact: plan.label,
      classification: plan.classification,
      risk: ownerOnly ? "R4" : riskOfClassification(plan.classification),
      sudo: machine.user !== "root",
      ownerOnly,
      area: "Virtual machines and containers",
      providerHash,
    };
  }
  if (provider.api === undefined)
    refuse(
      "Full Proxmox operations need the provider's api block (url, ca_file, token_entry) in the inventory",
      3,
    );
  if ((provider.operations ?? "guests") !== "full")
    refuse(
      `Full Proxmox operations are off for ${input.host}. Set operations: full on its provider in the inventory to allow them.`,
      3,
    );
  if (machine.access !== "full")
    refuse("Proxmox operations need a full-access host", 3);
  const op = fullOperation(
    {
      method: input.method as FullMethod,
      path: input.path as string,
      ...(input.params === undefined ? {} : { params: input.params }),
    },
    facts,
  );
  return {
    request: {
      api: { method: op.method, path: op.path, params: op.params },
    },
    argv: ["proxmox-api", op.method, op.path],
    impact: op.label,
    classification: op.classification,
    risk: op.risk,
    sudo: false,
    ownerOnly: op.ownerOnly,
    area: routeArea(op.path),
    providerHash,
  };
}
