// Windows alternative to the WinSW service: a scheduled task that runs `homectl serve` for
// the signed-in user at logon. It needs no service account password and no SYSTEM account.
// A dry run only builds the commands. A real install or removal changes the machine, so the
// CLI runs it only when the person passes --task without --dry-run.
import { selfCommand } from "./internal";
import { run } from "./process";
import { HomectlError } from "./types";

export const TASK_NAME = "homectl";

// The full command line for /TR. Every argument is quoted, and inner quotes are escaped.
export function taskCommand(executable: string, args: string[]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return [quote(executable), ...args.map(quote)].join(" ");
}

// Creates the task without /F, so an existing task is never overwritten.
export function createTaskArgv(command: string): string[] {
  return [
    "schtasks",
    "/Create",
    "/TN",
    TASK_NAME,
    "/TR",
    command,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
  ];
}

export function queryTaskArgv(): string[] {
  return ["schtasks", "/Query", "/TN", TASK_NAME];
}

export function deleteTaskArgv(): string[] {
  return ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"];
}

export function runTaskArgv(): string[] {
  return ["schtasks", "/Run", "/TN", TASK_NAME];
}

export function endTaskArgv(): string[] {
  return ["schtasks", "/End", "/TN", TASK_NAME];
}

// The task's command: this program, serving the inventory on one interface.
export function taskPlan(inventory: string, interfaceIP: string) {
  const [executable = process.execPath, ...entry] = selfCommand();
  const command = taskCommand(executable, [
    ...entry,
    "serve",
    "--inventory",
    inventory,
    "--interface",
    interfaceIP,
  ]);
  return { task: TASK_NAME, command, create: createTaskArgv(command) };
}

export type TaskOptions = {
  inventory: string;
  interfaceIP: string;
  dryRun?: boolean;
};

// Runs one service action through the scheduled task. Status is read-only and always runs.
export async function serviceTask(action: string, options: TaskOptions) {
  const plan = taskPlan(options.inventory, options.interfaceIP);
  const dry = (value: Record<string, unknown>) => ({
    action,
    task: TASK_NAME,
    credentialAccess: false,
    changed: false,
    ...value,
  });
  if (action === "install") {
    if (options.dryRun) return dry({ command: plan.command });
    const r = await run({ argv: plan.create });
    if (r.exitCode)
      throw new HomectlError(
        5,
        "The scheduled task could not be created. If it already exists, remove it with homectl service uninstall --task first.",
      );
    return {
      installed: true,
      task: TASK_NAME,
      next: "It starts at your next sign-in. Start it now with homectl service start --task.",
    };
  }
  if (action === "uninstall") {
    if (options.dryRun) return dry({});
    const r = await run({ argv: deleteTaskArgv() });
    if (r.exitCode)
      throw new HomectlError(
        5,
        "The scheduled task could not be removed. It may not exist.",
      );
    return { removed: true, task: TASK_NAME };
  }
  if (action === "status") {
    const r = await run({ argv: queryTaskArgv() });
    return { task: TASK_NAME, installed: r.exitCode === 0 };
  }
  if (action === "start" || action === "stop") {
    if (options.dryRun) return dry({});
    const r = await run({
      argv: action === "start" ? runTaskArgv() : endTaskArgv(),
    });
    if (r.exitCode)
      throw new HomectlError(
        5,
        `The task could not be ${action === "start" ? "started" : "stopped"}. Install it first with homectl service install --task.`,
      );
    return { action, task: TASK_NAME, ok: true };
  }
  throw new HomectlError(
    2,
    "With --task use install, uninstall, start, stop or status. Task history is in Task Scheduler.",
  );
}
