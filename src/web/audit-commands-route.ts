import {
  type AuditHistoryFilters,
  type AuditStatus,
  auditHistory,
} from "../control/audit-view";
import type { ControlPlane } from "../control/engine";
import { loadInventory } from "../inventory";
import { executeWithSSHConfig } from "../operations";
import type { Hub } from "../peer/hub";
import { availableCommandHosts, expandSavedCommand } from "../saved-commands";
import { HomectlError, type Runner } from "../types";
import { body, response } from "./http";

export async function auditCommandsRoute(
  req: Request,
  url: URL,
  options: {
    control: ControlPlane;
    hub: Hub;
    inventoryPath: string;
    configPath: string;
    operationRunner?: Runner;
  },
): Promise<Response | undefined> {
  const { control, hub, inventoryPath, configPath } = options;
  if (req.method === "GET" && url.pathname === "/api/commands") {
    const inventory = await loadInventory(inventoryPath);
    const { commands, invalid } = await hub.savedCommands.listWithIssues();
    return response({
      commands: [
        ...commands.map((command) => ({
          ...command,
          ...availableCommandHosts(command, Object.keys(inventory.machines)),
        })),
        ...invalid,
      ],
    });
  }
  if (req.method === "GET" && url.pathname === "/api/audit") {
    const host = url.searchParams.get("host") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const text = url.searchParams.get("text") || undefined;
    const cursorText = url.searchParams.get("cursor");
    const limitText = url.searchParams.get("limit");
    if (host && !/^[a-z][a-z0-9-]{0,62}$/.test(host))
      throw new HomectlError(2, "Choose a valid audit host filter");
    const statuses: AuditStatus[] = [
      "pending",
      "approved",
      "executing",
      "succeeded",
      "failed",
      "unknown",
      "refused",
      "approval-required",
    ];
    if (status && !statuses.includes(status as AuditStatus))
      throw new HomectlError(2, "Choose a valid audit status filter");
    if (text && text.length > 200)
      throw new HomectlError(
        2,
        "Audit search text must be 200 characters or fewer",
      );
    const positiveInteger = (value: string | null, label: string) => {
      if (value === null) return undefined;
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new HomectlError(2, `Audit ${label} must be a positive integer`);
      return number;
    };
    const cursor = positiveInteger(cursorText, "cursor");
    const limit = positiveInteger(limitText, "limit");
    const filters: AuditHistoryFilters = {
      ...(host ? { host } : {}),
      ...(status ? { status: status as AuditStatus } : {}),
      ...(text ? { text } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    const clients = await control.listClients();
    const names = Object.fromEntries(
      clients.map((client) => [client.id, client.name]),
    );
    return response(auditHistory(await control.auditEntries(), names, filters));
  }
  if (
    req.method !== "POST" ||
    ![
      "/api/commands/save",
      "/api/commands/remove",
      "/api/commands/run",
      "/api/exec",
    ].includes(url.pathname)
  )
    return undefined;
  const value = await body(req);
  if (url.pathname === "/api/commands/save")
    return response(
      await hub.serial(async () => {
        const command = await hub.savedCommands.save(
          value.command ?? value,
          typeof value.id === "string" ? value.id : undefined,
        );
        await hub.snapshot();
        return { command };
      }),
    );
  if (url.pathname === "/api/commands/remove")
    return response(
      await hub.serial(async () => {
        const command = await hub.savedCommands.remove(String(value.id ?? ""));
        await hub.snapshot();
        return { removed: command.id };
      }),
    );
  if (url.pathname === "/api/exec") {
    return response(
      await hub.serial(async () => {
        const inventory = await loadInventory(inventoryPath);
        const host = String(value.host ?? "");
        const machine = inventory.machines[host];
        if (
          !machine ||
          !Array.isArray(value.argv) ||
          value.argv.some((arg) => typeof arg !== "string") ||
          !value.argv.length
        )
          throw new HomectlError(2, "Select a machine and command arguments");
        return executeWithSSHConfig(host, machine, value.argv as string[], {
          configPath,
          machines: inventory.machines,
          dryRun: value.dryRun === true,
          approval:
            typeof value.approval === "string" ? value.approval : undefined,
          impact: typeof value.impact === "string" ? value.impact : undefined,
          runner: options.operationRunner,
          audit: {
            inventoryPath,
            requester: "local-operator",
            deviceName: hub.state.name,
            ...(typeof value.approval === "string"
              ? { approver: "local-operator" }
              : {}),
          },
        });
      }),
    );
  }
  if (url.pathname !== "/api/commands/run") return undefined;
  return response(
    await hub.serial(async () => {
      const command = await hub.savedCommands.resolve(
        typeof value.id === "string" ? value.id : "",
      );
      const inventory = await loadInventory(inventoryPath);
      const host =
        typeof value.host === "string"
          ? value.host
          : command.hosts.length === 1
            ? command.hosts[0]
            : undefined;
      if (!host) throw new HomectlError(2, "Select one saved-command host");
      const machine = inventory.machines[host];
      if (!machine)
        throw new HomectlError(3, `Host ${host} is unavailable on this device`);
      const parameters = value.parameters ?? {};
      if (
        typeof parameters !== "object" ||
        Array.isArray(parameters) ||
        Object.values(parameters).some((item) => typeof item !== "string")
      )
        throw new HomectlError(
          2,
          "Enter text values for the declared parameters",
        );
      const argv = expandSavedCommand(
        command,
        host,
        parameters as Record<string, string>,
      );
      return executeWithSSHConfig(host, machine, argv, {
        configPath,
        machines: inventory.machines,
        dryRun: value.dryRun === true,
        requireApproval: true,
        approval:
          typeof value.approval === "string" ? value.approval : undefined,
        impact: command.description || `Run saved command: ${command.name}`,
        runner: options.operationRunner,
        audit: {
          inventoryPath,
          requester: "local-operator",
          deviceName: hub.state.name,
          ...(typeof value.approval === "string"
            ? { approver: "local-operator" }
            : {}),
        },
      });
    }),
  );
}
