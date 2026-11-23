// `home-ctl proxmox`: plans Proxmox requests through the broker, as an agent
// client (the same way `home-ctl exec` goes through the broker in 0.3). Nothing
// here runs a command itself: the broker queues the request for the owner, who
// approves it in Needs you or with `home-ctl approve`.
import { parseArgs } from "node:util";
import { callBroker, clientToken, findEndpoint } from "../broker/client";
import { callWithWait } from "../broker/long-wait";
import { HomectlError } from "../types";

type Emit = (value: unknown, human?: string) => void;

export const PROXMOX_USAGE = [
  "home-ctl proxmox <host> <action> [--kind qemu|lxc] [--vmid N] [--template N|name] [--name text] [--storage id] [--memory-mb N] [--cores N] [--disk-gb N] [--bridge id] [--address dhcp|IPv4] [--cidr N] [--gateway IPv4] [--timeout-s N]",
  "home-ctl proxmox <host> api <GET|POST|PUT|DELETE> <path> [--param key=value ...]",
  "Options for both forms: --wait seconds (default 120, up to 600), --task <id>, --json.",
].join("\n");

// Catalogue actions: list, status, config, start, stop, reboot, shutdown,
// clone, create, destroy. restore is refused by the broker and by this parser.
const CATALOGUE_ACTIONS = new Set([
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
]);
const API_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

function wholeNumber(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HomectlError(2, `${flag} must be a whole number`);
  return Number(value);
}

// The parser for one `home-ctl proxmox` invocation. args excludes the command.
export function parseProxmoxArgs(args: string[]) {
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      kind: { type: "string" },
      vmid: { type: "string" },
      template: { type: "string" },
      name: { type: "string" },
      storage: { type: "string" },
      "memory-mb": { type: "string" },
      cores: { type: "string" },
      "disk-gb": { type: "string" },
      bridge: { type: "string" },
      address: { type: "string" },
      cidr: { type: "string" },
      gateway: { type: "string" },
      "timeout-s": { type: "string" },
      param: { type: "string", multiple: true },
      task: { type: "string" },
      wait: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const [host, action, ...rest] = positionals;
  if (!host || !action) throw new HomectlError(2, `Usage: ${PROXMOX_USAGE}`);
  const waitSeconds = v.wait === undefined ? 120 : Number(v.wait);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 600)
    throw new HomectlError(2, "--wait takes 0 to 600 seconds");
  const common = {
    host,
    waitMs: waitSeconds * 1000,
    ...(v.task === undefined ? {} : { task: v.task }),
  };
  if (action === "api") {
    const [method, path, ...extra] = rest;
    if (!method || !path || extra.length > 0)
      throw new HomectlError(
        2,
        "Usage: home-ctl proxmox <host> api <GET|POST|PUT|DELETE> <path> [--param key=value ...]",
      );
    if (!API_METHODS.has(method))
      throw new HomectlError(2, "Method must be GET, POST, PUT or DELETE");
    const params: Record<string, string> = {};
    for (const pair of v.param ?? []) {
      const at = pair.indexOf("=");
      if (at <= 0) throw new HomectlError(2, "--param takes key=value");
      params[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return {
      ...common,
      body: {
        method,
        path,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      },
    };
  }
  if (rest.length > 0 || !CATALOGUE_ACTIONS.has(action))
    throw new HomectlError(
      2,
      action === "restore"
        ? "Guest restore is disabled in homectl"
        : `Unknown Proxmox action: ${action}. Actions: ${[...CATALOGUE_ACTIONS].join(", ")}, or api`,
    );
  if (v.param !== undefined)
    throw new HomectlError(2, "--param goes with the api form");
  const kind = v.kind ?? "qemu";
  if (kind !== "qemu" && kind !== "lxc")
    throw new HomectlError(2, "--kind takes qemu or lxc");
  // Only the options given are sent; the broker checks every value.
  const catalogue: Record<string, unknown> = {
    kind,
    action,
  };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) catalogue[key] = value;
  };
  const { template } = v;
  set("vmid", wholeNumber(v.vmid, "--vmid"));
  set(
    "template",
    template === undefined
      ? undefined
      : /^[0-9]+$/.test(template)
        ? Number(template)
        : template,
  );
  set("name", v.name);
  set("storage", v.storage);
  set("memory_mb", wholeNumber(v["memory-mb"], "--memory-mb"));
  set("cores", wholeNumber(v.cores, "--cores"));
  set("disk_gb", wholeNumber(v["disk-gb"], "--disk-gb"));
  set("bridge", v.bridge);
  set("address", v.address);
  set("cidr", wholeNumber(v.cidr, "--cidr"));
  set("gateway", v.gateway);
  set("timeout_s", wholeNumber(v["timeout-s"], "--timeout-s"));
  return { ...common, body: { catalogue } };
}

function describe(view: {
  id: string;
  state: string;
  approvalSurface?: string;
  result?: { stdout: string; stderr: string };
  reason?: string;
  decision?: { reason: string };
}) {
  if (view.state === "awaiting-approval")
    return `Waiting for the owner to approve operation ${view.id}${view.approvalSurface ? ` at ${view.approvalSurface}` : ""}. Ask the user to approve it, then run: home-ctl wait ${view.id}`;
  if (view.result)
    return `${view.result.stdout}${view.result.stderr}`.trimEnd();
  return `Operation ${view.id}: ${view.state}${view.reason ? ` (${view.reason})` : ""}${view.decision ? ` - ${view.decision.reason}` : ""}`;
}

export async function proxmoxCommand(
  args: string[],
  options: { inventoryPath: string; emit: Emit },
): Promise<number> {
  const parsed = parseProxmoxArgs(args);
  const endpoint = await findEndpoint(options.inventoryPath);
  const token = await clientToken();
  if (!endpoint || !token)
    throw new HomectlError(
      5,
      "Proxmox requests go through the homectl broker as an agent client. Start the broker and connect this agent with `home-ctl agent connect`.",
    );
  const view = await callWithWait(
    (path, body) =>
      callBroker(path, body, { endpoint, authorization: `Bearer ${token}` }),
    "/v1/proxmox",
    {
      ...parsed.body,
      host: parsed.host,
      ...(parsed.task ? { task: parsed.task } : {}),
      waitMs: parsed.waitMs,
    },
  );
  options.emit(view, describe(view));
  return 0;
}
