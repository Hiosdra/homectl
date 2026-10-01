import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { credentialSpec } from "./credentials";
import { probeFailureMessage } from "./diagnostics";
import { checkApproval, planExecution } from "./policies";
import { run } from "./process";
import { sshConfig, transportSpec } from "./transports";
import { HomectlError, type Machine, type Runner } from "./types";
export const workerPath = resolve(import.meta.dir, "credentials/worker.ts");
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
  },
) {
  const plan = planExecution(host, machine, argv, options.impact);
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
    workerPath,
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
  await writeFile(path, sshConfig(machines), { mode: 0o600 });
}
