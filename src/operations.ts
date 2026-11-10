import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { credentialSpec } from "./credentials";
import { probeFailureMessage } from "./diagnostics";
import { internalCommand } from "./internal";
import { checkApproval, planExecution } from "./policies";
import { run } from "./process";
import { sshConfig, transportSpec } from "./transports";
import { HomectlError, type Machine, type Runner } from "./types";
export const workerArgv = internalCommand("worker");
export async function execute(
  host: string,
  machine: Machine,
  argv: string[],
  options: {
    configPath: string;
    dryRun?: boolean;
    approval?: string;
    impact?: string;
    runner?: Runner;
    catalogue?: boolean;
  },
) {
  const plan = planExecution(host, machine, argv, options.impact, {
    catalogue: options.catalogue === true,
  });
  if (options.dryRun) return { plan };
  checkApproval(plan, options.approval);
  if (
    machine.transport === "local" &&
    machine.access !== "full" &&
    process.getuid?.() === 0
  )
    throw new (await import("./types")).HomectlError(
      3,
      "Run homectl as a non-root existing user for non-full local tiers",
    );
  const spec = credentialSpec(
    machine.auth,
    transportSpec(machine, argv, options.configPath),
    workerArgv,
  );
  const result = await (options.runner ?? run)(spec);
  if (
    machine.auth?.type === "keepassxc" &&
    /homectl SSH session is locked/.test(result.stderr)
  )
    throw new HomectlError(5, probeFailureMessage(result));
  return { plan, result };
}
export async function writeSSHConfig(
  path: string,
  machines: Record<string, Machine>,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    sshConfig(machines, join(dirname(path), "known_hosts")),
    { mode: 0o600 },
  );
}
