import { credentialSpec } from "../credentials";
import { provisioningFailureMessage } from "../diagnostics";
import { workerPath } from "../operations";
import { run } from "../process";
import { transportSpec } from "../transports";
import {
  HomectlError,
  type Machine,
  type ProviderConfig,
  type Runner,
} from "../types";
import type { API } from ".";

// pvesh is the local Proxmox API interface, reached through the managed SSH key.
export function proxmoxSSH(
  config: ProviderConfig,
  host: Machine,
  configPath: string,
  runner: Runner = run,
  polling: { timeoutMs?: number; intervalMs?: number } = {},
): API {
  if (
    host.transport !== "ssh" ||
    host.access !== "full" ||
    host.auth?.type !== "keepassxc"
  )
    throw new HomectlError(
      2,
      "Proxmox requires a full SSH host with a managed key",
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(config.node))
    throw new HomectlError(2, "Invalid Proxmox node");
  const node = `/nodes/${config.node}`;
  const request: API["request"] = async (method, path, params) => {
    const verb = { GET: "get", POST: "create", PUT: "set" }[method];
    if (!verb || !path.startsWith(`${node}/`))
      throw new HomectlError(2, "Invalid Proxmox method/node");
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      throw new HomectlError(2, "Invalid Proxmox resource encoding");
    }
    const resource = decodedPath.slice(node.length);
    const valid =
      method === "GET"
        ? /^\/qemu(?:\/\d+\/config)?$/.test(resource) ||
          /^\/tasks\/UPID:[A-Za-z0-9:_.@!-]+\/status$/.test(resource)
        : method === "POST"
          ? /^\/qemu\/\d+\/(clone|status\/start)$/.test(resource)
          : /^\/qemu\/\d+\/(config|resize)$/.test(resource);
    if (!valid)
      throw new HomectlError(2, "Unsupported Proxmox provisioning resource");
    const parameters = Object.entries(params ?? {}).flatMap(([key, value]) => {
      if (!/^[a-z][a-z0-9_]*$/.test(key))
        throw new HomectlError(2, "Invalid Proxmox parameter name");
      return [
        `--${key}`,
        key === "sshkeys" ? encodeURIComponent(String(value)) : String(value),
      ];
    });
    const result = await runner(
      credentialSpec(
        host.auth,
        transportSpec(
          host,
          [
            ...(host.user === "root" ? [] : ["sudo", "-n"]),
            "pvesh",
            "--noproxy",
            verb,
            decodedPath,
            "--output-format",
            "json",
            ...parameters,
          ],
          configPath,
        ),
        workerPath,
      ),
    );
    if (result.exitCode)
      throw new HomectlError(5, provisioningFailureMessage(result));
    if (!result.stdout.trim()) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new HomectlError(
        5,
        "Proxmox returned invalid JSON; raw output suppressed",
      );
    }
  };
  return {
    request,
    async wait(task) {
      if (!/^UPID:[A-Za-z0-9:_.@!-]+$/.test(task))
        throw new HomectlError(5, "Invalid Proxmox task ID");
      const deadline = Date.now() + (polling.timeoutMs ?? 600_000);
      while (Date.now() < deadline) {
        const state = (await request(
          "GET",
          `${node}/tasks/${encodeURIComponent(task)}/status`,
        )) as { status: string; exitstatus?: string };
        if (!state || !["running", "stopped"].includes(state.status))
          throw new HomectlError(
            5,
            "Invalid Proxmox task status; raw output suppressed and journal retained",
          );
        if (state.status === "stopped") {
          if (state.exitstatus !== "OK")
            throw new HomectlError(
              5,
              "Proxmox task failed; inspect task in UI and retained journal",
            );
          return;
        }
        await Bun.sleep(polling.intervalMs ?? 1000);
      }
      throw new HomectlError(
        5,
        "Proxmox task timed out; journal retained for recovery",
      );
    },
  };
}
