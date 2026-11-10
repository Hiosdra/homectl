// Typed Proxmox guest catalogue (slice 5, docs/homectl-2.0/proxmox-adapters.md).
// Every action becomes one exact argv built from validated fields. Free-form
// `qm` and `pct` argv is never accepted through the generic plan path.
import { basename } from "node:path";
import { HomectlError, type ProviderConfig } from "../types";

export type ProxmoxKind = "qemu" | "lxc";
export type ProxmoxAction =
  | "list"
  | "status"
  | "config"
  | "start"
  | "stop"
  | "reboot"
  | "shutdown"
  | "clone"
  | "create"
  | "destroy";

// Facts about one Proxmox node, taken from the inventory provider entry.
export interface ProxmoxFacts {
  host: string;
  node: string;
  vmidMin: number;
  vmidMax: number;
  // True only when the inventory sets vmid_range. Changes need it.
  vmidRangeSet: boolean;
  protectedVmids: number[];
  storages: string[];
  templates: string[];
}

export interface ProxmoxInput {
  kind: ProxmoxKind;
  action: ProxmoxAction;
  vmid?: number;
  template?: number | string;
  name?: string;
  storage?: string;
  memory_mb?: number;
  cores?: number;
  disk_gb?: number;
  bridge?: string;
  address?: string; // "dhcp" or an IPv4 address
  cidr?: number;
  gateway?: string;
  timeout_s?: number;
}

export interface ProxmoxPlan {
  argv: string[]; // inner argv, without any sudo prefix
  label: string; // friendly text shown on the approval
  classification: "inspect" | "mutation" | "destructive";
}

export const DEFAULT_VMID_RANGE: [number, number] = [100, 999_999_999];
// Actions that change or remove a guest. They need an explicit vmid_range.
const CHANGE_ACTIONS: ProxmoxAction[] = [
  "start",
  "stop",
  "reboot",
  "shutdown",
  "clone",
  "create",
  "destroy",
];
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const STORAGE = /^[a-zA-Z0-9_-]{1,32}$/;
const BRIDGE = /^vmbr[0-9]{1,3}$/;
const TEMPLATE_FILE = /^[A-Za-z0-9._+-]{1,128}\.tar\.(gz|xz|zst)$/;
const ID = /^[1-9][0-9]{2,8}$/;

export function providerFacts(provider: ProviderConfig): ProxmoxFacts {
  const [vmidMin, vmidMax] = provider.vmid_range ?? DEFAULT_VMID_RANGE;
  return {
    host: provider.host,
    node: provider.node,
    vmidMin,
    vmidMax,
    vmidRangeSet: provider.vmid_range !== undefined,
    protectedVmids: provider.protected_vmids ?? [],
    storages: provider.storages ?? [],
    templates: provider.templates ?? [],
  };
}

const ipv4 = (value: string): boolean =>
  /^(\d{1,3}\.){3}\d{1,3}$/.test(value) &&
  value.split(".").every((part) => Number(part) <= 255);

function invalid(message: string): never {
  throw new HomectlError(2, message);
}

function vmidOf(value: unknown, facts: ProxmoxFacts, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < facts.vmidMin ||
    value > facts.vmidMax
  )
    invalid(
      `${label} must be an integer between ${facts.vmidMin} and ${facts.vmidMax}`,
    );
  return value;
}

function inRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    invalid(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

// Builds the exact argv and label for one catalogue action. The node is always
// the provider's node; the request cannot name another one.
export function buildProxmoxPlan(
  input: ProxmoxInput,
  facts: ProxmoxFacts,
): ProxmoxPlan {
  const { kind, action } = input;
  const cmd = kind === "qemu" ? "qm" : "pct";
  const type = kind === "qemu" ? "VM" : "CT";
  const suffix = input.name ? ` (${input.name})` : "";
  if (action === "list") {
    return {
      argv: [cmd, "list"],
      label: `List ${kind === "qemu" ? "VMs" : "containers"} on ${facts.node}`,
      classification: "inspect",
    };
  }
  if (CHANGE_ACTIONS.includes(action) && !facts.vmidRangeSet)
    invalid(
      `Set vmid_range for ${facts.host} in the inventory before planning VM changes`,
    );
  if (action === "clone") {
    if (kind !== "qemu") invalid("Clone is available for QEMU VMs only");
    const vmid = vmidOf(input.vmid, facts, "VMID");
    const template = vmidOf(input.template, facts, "Template VMID");
    if (template === vmid) invalid("VMID must differ from the template");
    if (typeof input.name !== "string" || !NAME.test(input.name))
      invalid("Name must be lowercase letters, digits and dashes");
    const argv = [
      "qm",
      "clone",
      String(template),
      String(vmid),
      "--name",
      input.name,
      "--full",
      "1",
    ];
    if (input.storage !== undefined) {
      if (!facts.storages.includes(input.storage))
        invalid("Storage is not allowed for this Proxmox provider");
      argv.push("--storage", input.storage);
    }
    return {
      argv,
      label: `Clone VM ${template} to ${vmid} (${input.name})`,
      classification: "mutation",
    };
  }
  if (action === "create") {
    if (kind !== "lxc")
      invalid("Create from template is available for LXC containers only");
    const vmid = vmidOf(input.vmid, facts, "VMID");
    if (typeof input.name !== "string" || !NAME.test(input.name))
      invalid("Name must be lowercase letters, digits and dashes");
    if (
      typeof input.template !== "string" ||
      !TEMPLATE_FILE.test(input.template) ||
      !facts.templates.includes(input.template)
    )
      invalid("Template is not allowed for this Proxmox provider");
    if (
      typeof input.storage !== "string" ||
      !facts.storages.includes(input.storage)
    )
      invalid("Storage is not allowed for this Proxmox provider");
    const memory = inRange(input.memory_mb, 128, 1_048_576, "Memory (MB)");
    const cores = inRange(input.cores, 1, 256, "Cores");
    const disk = inRange(input.disk_gb, 1, 65_536, "Root disk (GB)");
    if (typeof input.bridge !== "string" || !BRIDGE.test(input.bridge))
      invalid("Bridge must look like vmbr0");
    let ip = "dhcp";
    if (input.address !== undefined && input.address !== "dhcp") {
      if (
        !ipv4(input.address) ||
        typeof input.cidr !== "number" ||
        !Number.isInteger(input.cidr) ||
        input.cidr < 1 ||
        input.cidr > 32 ||
        typeof input.gateway !== "string" ||
        !ipv4(input.gateway)
      )
        invalid(
          "Static networking needs an IPv4 address, a CIDR of 1 to 32 and an IPv4 gateway",
        );
      ip = `${input.address}/${input.cidr},gw=${input.gateway}`;
    }
    return {
      argv: [
        "pct",
        "create",
        String(vmid),
        `${input.storage}:vztmpl/${input.template}`,
        "--hostname",
        input.name,
        // Always unprivileged: a privileged container is not in the catalogue.
        "--unprivileged",
        "1",
        "--memory",
        String(memory),
        "--cores",
        String(cores),
        "--rootfs",
        `${input.storage}:${disk}`,
        "--net0",
        `name=eth0,bridge=${input.bridge},ip=${ip}`,
      ],
      label: `Create CT ${vmid} (${input.name}) from ${input.template}`,
      classification: "mutation",
    };
  }
  const vmid = vmidOf(input.vmid, facts, "VMID");
  switch (action) {
    case "status":
    case "config":
      return {
        argv: [cmd, action, String(vmid)],
        label: `${action === "status" ? "Status of" : "Configuration of"} ${type} ${vmid}${suffix}`,
        classification: "inspect",
      };
    case "start":
    case "stop":
    case "reboot":
      return {
        argv: [cmd, action, String(vmid)],
        label: `${action[0]?.toUpperCase()}${action.slice(1)} ${type} ${vmid}${suffix}`,
        classification: "mutation",
      };
    case "shutdown": {
      const timeout =
        input.timeout_s === undefined
          ? 120
          : inRange(input.timeout_s, 10, 600, "Shutdown timeout (s)");
      return {
        argv: [cmd, "shutdown", String(vmid), "--timeout", String(timeout)],
        label: `Shut down ${type} ${vmid}${suffix}`,
        classification: "mutation",
      };
    }
    case "destroy": {
      // Destroy always names the guest, so the approval shows what will be purged.
      if (typeof input.name !== "string" || !NAME.test(input.name))
        invalid(
          "Destroy needs the guest name: lowercase letters, digits and dashes",
        );
      if (facts.protectedVmids.includes(vmid))
        invalid(
          `VM ${vmid} is listed in protected_vmids for ${facts.host} and cannot be destroyed`,
        );
      return {
        argv: [cmd, "destroy", String(vmid), "--purge"],
        label: `Destroy ${type} ${vmid} (${input.name}) and purge its disks`,
        classification: "destructive",
      };
    }
    default:
      return invalid("Unknown Proxmox action");
  }
}

// Shape-only check for the policy layer. The argv must be one exact catalogue
// form; facts (node, VMID range, storage and template allowlists) are checked
// when the plan is built. Returns undefined for anything else.
export function catalogueClass(
  args: string[],
): "inspect" | "mutation" | "destructive" | undefined {
  const [cmd, sub, ...rest] = args;
  if (cmd !== "qm" && cmd !== "pct") return undefined;
  const id = (value: string | undefined) =>
    value !== undefined && ID.test(value);
  if (sub === "list" && rest.length === 0) return "inspect";
  if (
    (sub === "status" || sub === "config") &&
    rest.length === 1 &&
    id(rest[0])
  )
    return "inspect";
  if (
    (sub === "start" || sub === "stop" || sub === "reboot") &&
    rest.length === 1 &&
    id(rest[0])
  )
    return "mutation";
  if (
    sub === "shutdown" &&
    rest.length === 3 &&
    id(rest[0]) &&
    rest[1] === "--timeout" &&
    /^\d{2,3}$/.test(rest[2] ?? "")
  )
    return "mutation";
  if (
    sub === "destroy" &&
    rest.length === 2 &&
    id(rest[0]) &&
    rest[1] === "--purge"
  )
    return "destructive";
  if (cmd === "qm" && sub === "clone") {
    const [template, vmid, flag, name, full, one, ...more] = rest;
    if (
      !id(template) ||
      !id(vmid) ||
      flag !== "--name" ||
      !NAME.test(name ?? "") ||
      full !== "--full" ||
      one !== "1"
    )
      return undefined;
    if (more.length === 0) return "mutation";
    if (
      more.length === 2 &&
      more[0] === "--storage" &&
      STORAGE.test(more[1] ?? "")
    )
      return "mutation";
    return undefined;
  }
  if (cmd === "pct" && sub === "create") {
    const [vmid, volume, ...flags] = rest;
    if (
      !id(vmid) ||
      !/^[a-zA-Z0-9_-]{1,32}:vztmpl\/[A-Za-z0-9._+-]{1,128}\.tar\.(gz|xz|zst)$/.test(
        volume ?? "",
      )
    )
      return undefined;
    const allowed = new Set([
      "--hostname",
      "--unprivileged",
      "--memory",
      "--cores",
      "--rootfs",
      "--net0",
    ]);
    for (let i = 0; i < flags.length; i += 2) {
      if (!allowed.has(flags[i] ?? "") || flags[i + 1] === undefined)
        return undefined;
    }
    if (flags[flags.indexOf("--unprivileged") + 1] !== "1") return undefined;
    return "mutation";
  }
  return undefined;
}

// True for any `qm` or `pct` argv, after an optional sudo prefix.
export function isGuestArgv(args: string[]): boolean {
  return ["qm", "pct"].includes(basename(args[0] ?? ""));
}
