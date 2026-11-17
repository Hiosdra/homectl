import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { execute, writeSSHConfig } from "../operations";
import {
  availableCommandHosts,
  expandSavedCommand,
  SavedCommandStore,
} from "../saved-commands";
import { HomectlError, type Inventory } from "../types";

export async function runCommands(options: {
  positionals: string[];
  commandArgs: string[];
  inventoryPath: string;
  configPath: string;
  inventory: Inventory;
  dryRun: boolean;
  file?: string;
  id?: string;
  parametersFile?: string;
  target?: string;
  approval?: string;
  impact?: string;
  emit: (value: unknown) => void;
}): Promise<number> {
  const [, action, idOrName] = options.positionals;
  const store = SavedCommandStore.forInventory(options.inventoryPath);
  if (
    action === "list" &&
    options.positionals.length === 2 &&
    !options.commandArgs.length
  ) {
    options.emit(
      (await store.list()).map((saved) => ({
        ...saved,
        ...availableCommandHosts(
          saved,
          Object.keys(options.inventory.machines),
        ),
      })),
    );
    return 0;
  }
  if (
    action === "save" &&
    options.positionals.length === 2 &&
    !options.commandArgs.length
  ) {
    if (!options.file)
      throw new HomectlError(2, "Save a JSON template with --file PATH");
    const template = JSON.parse(await readFile(resolve(options.file), "utf8"));
    options.emit({ command: await store.save(template, options.id) });
    return 0;
  }
  if (
    action === "rm" &&
    options.positionals.length === 3 &&
    !options.commandArgs.length
  ) {
    if (options.id !== undefined || options.file || options.parametersFile)
      throw new HomectlError(2, "commands rm takes an id or name only");
    options.emit({ removed: (await store.remove(idOrName ?? "")).id });
    return 0;
  }
  if (action === "run" && options.positionals.length === 3) {
    const saved = await store.resolve(idOrName ?? "");
    const host =
      options.target || (saved.hosts.length === 1 ? saved.hosts[0] : undefined);
    if (!host)
      throw new HomectlError(
        2,
        "Choose a saved command host with --target HOST",
      );
    const machine = options.inventory.machines[host];
    if (!machine)
      throw new HomectlError(3, `Host ${host} is unavailable on this device`);
    const parameters: Record<string, string> = {};
    if (options.parametersFile) {
      const loaded = JSON.parse(
        await readFile(resolve(options.parametersFile), "utf8"),
      );
      if (
        !loaded ||
        typeof loaded !== "object" ||
        Array.isArray(loaded) ||
        Object.values(loaded).some((value) => typeof value !== "string")
      )
        throw new HomectlError(
          2,
          "Parameter file must be a JSON object of text values",
        );
      Object.assign(parameters, loaded);
    }
    for (const item of options.commandArgs) {
      const equalAt = item.indexOf("=");
      if (equalAt < 1)
        throw new HomectlError(
          2,
          "Pass parameter values after -- as name=value",
        );
      const name = item.slice(0, equalAt);
      if (Object.hasOwn(parameters, name))
        throw new HomectlError(
          2,
          `Parameter ${name} was provided more than once`,
        );
      parameters[name] = item.slice(equalAt + 1);
    }
    const argv = expandSavedCommand(saved, host, parameters);
    if (!options.dryRun)
      await writeSSHConfig(options.configPath, options.inventory.machines);
    const result = await execute(host, machine, argv, {
      configPath: options.configPath,
      dryRun: options.dryRun,
      approval: options.approval,
      requireApproval: true,
      impact:
        options.impact ||
        saved.description ||
        `Run saved command: ${saved.name}`,
      audit: {
        inventoryPath: options.inventoryPath,
        requester: "local-operator",
        requesterName: hostname(),
        ...(options.approval ? { approver: "local-operator" } : {}),
      },
    });
    options.emit(result);
    return "result" in result && result.result && result.result.exitCode !== 0
      ? 6
      : 0;
  }
  throw new HomectlError(
    2,
    "Use commands list, save --file PATH, run <id>, or rm <id>",
  );
}
