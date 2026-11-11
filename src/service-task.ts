// Windows alternative to the WinSW service: a scheduled task that runs `homectl serve` for
// the signed-in user at logon. It needs no service account password and no SYSTEM account.
// This module only builds the commands. Creating the task changes the machine, so the CLI
// runs it only after an explicit request.
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
