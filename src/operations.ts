import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { recordLocalCommand } from "./command-history";
import { credentialSpec } from "./credentials";
import { probeFailureMessage } from "./diagnostics";
import { internalCommand } from "./internal";
import { checkApproval, innerCommand, planExecution } from "./policies";
import { run } from "./process";
import { sessionStatus } from "./session";
import { sshConfig, transportSpec } from "./transports";
import {
  type ExecutionPlan,
  HomectlError,
  type Machine,
  type Runner,
} from "./types";
export const workerArgv = internalCommand("worker");

type ExecuteOptions = {
  configPath: string;
  dryRun?: boolean;
  approval?: string;
  approvalContext?: "cli" | "panel" | "peer";
  impact?: string;
  displayArgv?: string[];
  auditArgv?: string[];
  displayImpact?: string;
  requireApproval?: boolean;
  runner?: Runner;
  catalogue?: boolean;
  getUid?: () => number | undefined;
  beforeRun?: () => Promise<void>;
  audit?: {
    inventoryPath: string;
    requester?: string;
    requesterName?: string;
    device?: string;
    deviceName?: string;
    approver?: string;
    operationId?: string;
  };
};

export function execute(
  host: string,
  machine: Machine,
  argv: string[],
  options: ExecuteOptions & { dryRun: true },
): Promise<{ plan: ExecutionPlan }>;
export function execute(
  host: string,
  machine: Machine,
  argv: string[],
  options: ExecuteOptions & { dryRun?: false },
): Promise<{
  plan: ExecutionPlan;
  result: Awaited<ReturnType<Runner>>;
}>;
export function execute(
  host: string,
  machine: Machine,
  argv: string[],
  options: ExecuteOptions,
): Promise<
  | { plan: ExecutionPlan }
  | {
      plan: ExecutionPlan;
      result: Awaited<ReturnType<Runner>>;
    }
>;
export async function execute(
  host: string,
  machine: Machine,
  argv: string[],
  options: ExecuteOptions,
) {
  const operationId = options.audit?.operationId ?? randomUUID();
  let approvedBy: string | undefined;
  const recordHistory = (
    phase: "started" | "outcome",
    status:
      | "executing"
      | "succeeded"
      | "failed"
      | "unknown"
      | "refused"
      | "approval-required",
    details: {
      classification?: ExecutionPlan["classification"];
      policyDecision: "allowed" | "needs-approval" | "refused";
      reason?: string;
      exitCode?: number;
      startedAt?: number;
    },
  ) => {
    if (!options.audit || options.dryRun) return;
    if ((options.getUid?.() ?? process.getuid?.()) === 0) {
      console.warn(
        "Local command history was not written because homectl is running as root.",
      );
      return;
    }
    recordLocalCommand({
      inventoryPath: options.audit.inventoryPath,
      host,
      argv: options.auditArgv ?? argv,
      phase,
      status,
      policyDecision: details.policyDecision,
      operationId,
      requester: options.audit.device ?? options.audit.requester,
      requesterName: options.audit.deviceName ?? options.audit.requesterName,
      ...(approvedBy ? { approver: approvedBy } : {}),
      ...(details.classification
        ? { classification: details.classification }
        : {}),
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
      ...(details.startedAt === undefined
        ? {}
        : { startedAt: details.startedAt }),
      finishedAt: Date.now(),
    });
  };
  if (
    !options.dryRun &&
    machine.transport === "local" &&
    machine.access !== "full" &&
    (options.getUid?.() ?? process.getuid?.()) === 0
  ) {
    recordHistory("outcome", "refused", {
      policyDecision: "refused",
      reason: "root-local-tier-refused",
    });
    throw new HomectlError(
      3,
      "Run homectl as a non-root existing user for non-full local tiers",
    );
  }
  let plan: ExecutionPlan;
  try {
    plan = planExecution(host, machine, argv, options.impact, {
      catalogue: options.catalogue === true,
    });
  } catch (error) {
    if (!options.dryRun)
      recordHistory("outcome", "refused", {
        policyDecision: "refused",
        reason: "policy-refused",
      });
    throw error;
  }
  if (options.displayArgv) plan.argv = [...options.displayArgv];
  if (options.displayImpact) plan.impact = options.displayImpact;
  if (
    options.requireApproval &&
    (plan.classification !== "inspect" || innerCommand(argv).sudo)
  )
    plan.needsApproval = true;
  if (options.dryRun) return { plan };
  try {
    checkApproval(plan, options.approval, options.approvalContext);
    approvedBy = plan.needsApproval ? options.audit?.approver : undefined;
  } catch (error) {
    const approvalRequired = error instanceof HomectlError && error.code === 4;
    recordHistory(
      "outcome",
      approvalRequired ? "approval-required" : "refused",
      {
        classification: plan.classification,
        policyDecision: approvalRequired ? "needs-approval" : "refused",
        reason: approvalRequired ? "approval-required" : "approval-invalid",
      },
    );
    throw error;
  }
  if (
    machine.auth?.type === "keepassxc" &&
    options.audit?.inventoryPath &&
    !(await sessionStatus(options.audit.inventoryPath)).unlocked
  ) {
    recordHistory("outcome", "refused", {
      classification: plan.classification,
      policyDecision: "refused",
      reason: "SSH session locked",
    });
    throw new HomectlError(
      5,
      probeFailureMessage({
        exitCode: 5,
        stdout: "",
        stderr: "homectl SSH session is locked",
      }),
    );
  }
  await options.beforeRun?.();
  const spec = credentialSpec(
    machine.auth,
    transportSpec(machine, argv, options.configPath),
    workerArgv,
  );
  const startedAt = Date.now();
  const policyDecision = plan.needsApproval ? "needs-approval" : "allowed";
  recordHistory("started", "executing", {
    classification: plan.classification,
    policyDecision,
    startedAt,
  });
  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await (options.runner ?? run)(spec);
  } catch (error) {
    recordHistory("outcome", "unknown", {
      classification: plan.classification,
      policyDecision,
      reason: "execution-outcome-unknown",
      startedAt,
    });
    throw error;
  }
  if (
    machine.auth?.type === "keepassxc" &&
    /homectl SSH session is locked/.test(result.stderr)
  ) {
    recordHistory("outcome", "refused", {
      classification: plan.classification,
      policyDecision: "refused",
      reason: "SSH session locked",
      startedAt,
    });
    throw new HomectlError(5, probeFailureMessage(result));
  }
  const exitCode =
    Number.isInteger(result.exitCode) &&
    result.exitCode >= 0 &&
    result.exitCode <= 255
      ? result.exitCode
      : undefined;
  recordHistory("outcome", exitCode === 0 ? "succeeded" : "failed", {
    classification: plan.classification,
    policyDecision,
    ...(exitCode === undefined ? {} : { exitCode }),
    startedAt,
  });
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

export function executeWithSSHConfig(
  host: string,
  machine: Machine,
  argv: string[],
  options: Omit<ExecuteOptions, "beforeRun"> & {
    machines: Record<string, Machine>;
  },
) {
  const { machines, ...executionOptions } = options;
  return execute(host, machine, argv, {
    ...executionOptions,
    beforeRun: () => writeSSHConfig(options.configPath, machines),
  });
}
