import { hostname } from "node:os";
import { resolveHost } from "../inventory";
import { execute, writeSSHConfig } from "../operations";
import { doctor } from "../setup";
import { HomectlError, type Inventory } from "../types";

export async function hostCommand(
  command: string | undefined,
  host: string | undefined,
  options: {
    inventory: Inventory;
    inventoryPath: string;
    configPath: string;
    commandArgs: string[];
    dryRun: boolean;
    approval?: string;
    impact?: string;
    emit: (value: unknown) => void;
  },
): Promise<number | undefined> {
  if (command === "hosts") {
    options.emit(options.inventory.machines);
    return 0;
  }
  if (command === "inspect") {
    if (!host) throw new HomectlError(2, "Specify host");
    options.emit({ host, ...resolveHost(options.inventory, host) });
    return 0;
  }
  if (command === "doctor") {
    if (options.dryRun) {
      options.emit({ wouldCheck: host ?? "tools", credentialFetch: false });
      return 0;
    }
    await writeSSHConfig(options.configPath, options.inventory.machines);
    const result = await doctor(options.inventory, options.configPath, host);
    options.emit(result);
    return result.ok ? 0 : 5;
  }
  if (command === "exec" || command === "ssh") {
    if (!host) throw new HomectlError(2, "Specify host");
    if (!options.dryRun)
      await writeSSHConfig(options.configPath, options.inventory.machines);
    const result = await execute(
      host,
      resolveHost(options.inventory, host),
      options.commandArgs,
      {
        configPath: options.configPath,
        dryRun: options.dryRun,
        approval: options.approval,
        impact: options.impact,
        audit: {
          inventoryPath: options.inventoryPath,
          requester: "local-operator",
          requesterName: hostname(),
          ...(options.approval ? { approver: "local-operator" } : {}),
        },
      },
    );
    options.emit(result);
    return "result" in result && result.result && result.result.exitCode !== 0
      ? 6
      : 0;
  }
  if (command === "sudoers") {
    if (!host) throw new HomectlError(2, "Specify host");
    const machine = resolveHost(options.inventory, host);
    options.emit(
      (await import("../policies")).sudoers(machine.user ?? "", machine),
    );
    return 0;
  }
  return undefined;
}
