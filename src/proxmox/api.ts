// Proxmox VE API transport for the typed guest catalogue (option B, homelab #5).
// The approved argv is the source of truth. Every request is derived from that
// same validated argv, so the API call matches what the approver saw. The API
// token is held by the session agent and sent only over TLS, with the node CA
// pinned from a file in the inventory.

import { HomectlError } from "../types";
import {
  buildProxmoxPlan,
  type ProxmoxFacts,
  type ProxmoxInput,
} from "./catalogue";

export interface ApiRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  // Form fields for POST, or query for DELETE with purge.
  params: Record<string, string>;
  // True when the API answers with a task id (UPID) to poll.
  task: boolean;
  // Read-only actions never change the guest.
  inspect: boolean;
}

export type ApiFetch = (
  url: string,
  init: RequestInit & { tls?: { ca: string } },
) => Promise<Response>;

export interface ApiTarget {
  // Base URL from the inventory, for example https://pve.example:8006.
  baseUrl: string;
  // PEM of the node CA, read from the inventory's ca_file.
  caPem: string;
  // Full Authorization header value. Never logged or returned.
  authorization: string;
}

export interface ApiRunOptions {
  fetcher?: ApiFetch;
  sleep?: (ms: number) => Promise<void>;
  // Task polling budget, and interval, in ms.
  taskTimeoutMs?: number;
  pollMs?: number;
}

function flagValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined)
    throw new HomectlError(
      2,
      `Plan is missing ${flag}; refusing to call the API`,
    );
  return value;
}

// Maps one validated catalogue plan to an API request. Validation is the
// existing buildProxmoxPlan, so the same refusals apply on both transports.
export function apiRequestFor(
  input: ProxmoxInput,
  facts: ProxmoxFacts,
): ApiRequest {
  const plan = buildProxmoxPlan(input, facts);
  const argv = plan.argv;
  const node = encodeURIComponent(facts.node);
  const type = input.kind === "qemu" ? "qemu" : "lxc";
  const vmid = input.vmid === undefined ? "" : String(input.vmid);
  const guest = `/nodes/${node}/${type}`;
  switch (input.action) {
    case "list":
      return {
        method: "GET",
        path: guest,
        params: {},
        task: false,
        inspect: true,
      };
    case "status":
      return {
        method: "GET",
        path: `${guest}/${vmid}/status/current`,
        params: {},
        task: false,
        inspect: true,
      };
    case "config":
      return {
        method: "GET",
        path: `${guest}/${vmid}/config`,
        params: {},
        task: false,
        inspect: true,
      };
    case "start":
    case "stop":
    case "reboot":
      return {
        method: "POST",
        path: `${guest}/${vmid}/status/${input.action}`,
        params: {},
        task: true,
        inspect: false,
      };
    case "shutdown":
      return {
        method: "POST",
        path: `${guest}/${vmid}/status/shutdown`,
        params: { timeout: flagValue(argv, "--timeout") },
        task: true,
        inspect: false,
      };
    case "clone": {
      // argv: qm clone <template> <vmid> --name N --full 1 [--storage S]
      const template = argv[2] ?? "";
      const params: Record<string, string> = {
        newid: argv[3] ?? "",
        name: flagValue(argv, "--name"),
        full: "1",
      };
      if (argv.includes("--storage"))
        params.storage = flagValue(argv, "--storage");
      return {
        method: "POST",
        path: `/nodes/${node}/qemu/${template}/clone`,
        params,
        task: true,
        inspect: false,
      };
    }
    case "create": {
      // argv: pct create <vmid> <storage:vztmpl/template> --hostname N --unprivileged 1 ...
      return {
        method: "POST",
        path: `/nodes/${node}/lxc`,
        params: {
          vmid: argv[2] ?? "",
          ostemplate: argv[3] ?? "",
          hostname: flagValue(argv, "--hostname"),
          unprivileged: "1",
          memory: flagValue(argv, "--memory"),
          cores: flagValue(argv, "--cores"),
          rootfs: flagValue(argv, "--rootfs"),
          net0: flagValue(argv, "--net0"),
        },
        task: true,
        inspect: false,
      };
    }
    case "destroy":
      // argv: qm|pct destroy <vmid> --purge
      return {
        method: "DELETE",
        path: `${guest}/${vmid}`,
        params: { purge: "1" },
        task: true,
        inspect: false,
      };
    default:
      throw new HomectlError(2, "Unknown Proxmox action");
  }
}

// Runs one request. Returns the same shape as a local process result, so the
// engine records it in the same way. A task still running at the budget is
// reported as an exception, which the engine records as `unknown`.
export async function runProxmoxApi(
  target: ApiTarget,
  node: string,
  request: ApiRequest,
  options: ApiRunOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const headers = {
    Authorization: target.authorization,
    Accept: "application/json",
  };
  const call = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string> = {},
  ): Promise<{ ok: boolean; status: number; data?: unknown }> => {
    const url = new URL(`/api2/json${path}`, target.baseUrl);
    const body =
      method === "POST" ? new URLSearchParams(params).toString() : undefined;
    if (method !== "POST")
      for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
    const response = await fetcher(url.toString(), {
      method,
      headers: {
        ...headers,
        ...(body !== undefined
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      tls: { ca: target.caPem },
    });
    let data: unknown;
    try {
      data = ((await response.json()) as { data?: unknown }).data;
    } catch {
      return { ok: response.ok, status: response.status };
    }
    return { ok: response.ok, status: response.status, data };
  };

  const first = await call(request.method, request.path, request.params);
  if (!first.ok)
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Proxmox API returned HTTP ${first.status}`,
    };
  if (request.inspect)
    return {
      exitCode: 0,
      stdout: JSON.stringify(first.data ?? null),
      stderr: "",
    };
  if (
    !request.task ||
    typeof first.data !== "string" ||
    !first.data.startsWith("UPID:")
  )
    return { exitCode: 0, stdout: "", stderr: "" };

  // Poll the task until it stops, or the budget runs out.
  const upid = encodeURIComponent(first.data);
  const budget = options.taskTimeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + budget;
  for (;;) {
    const status = await call(
      "GET",
      `/nodes/${encodeURIComponent(node)}/tasks/${upid}/status`,
    );
    const task = status.data as
      | { status?: string; exitstatus?: string }
      | undefined;
    if (status.ok && task?.status === "stopped") {
      const outcome = String(task.exitstatus ?? "");
      return outcome === "OK"
        ? { exitCode: 0, stdout: first.data, stderr: "" }
        : {
            exitCode: 1,
            stdout: first.data,
            stderr: `Task ended: ${outcome.slice(0, 160)}`,
          };
    }
    if (Date.now() >= deadline)
      throw new Error("Proxmox task did not finish within the budget");
    await sleep(pollMs);
  }
}
