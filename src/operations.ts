import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendLocalAudit } from "./control/journal";
import { normalizeAuditArgv } from "./control/redact";
import { credentialSpec } from "./credentials";
import { probeFailureMessage } from "./diagnostics";
import { internalCommand } from "./internal";
import { checkApproval, innerCommand, planExecution } from "./policies";
import { run } from "./process";
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
  auditWarning?: string;
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
      auditWarning?: string;
    }
>;
export async function execute(
  host: string,
  machine: Machine,
  argv: string[],
  options: ExecuteOptions,
) {
  const operationId = options.audit?.operationId ?? randomUUID();
  const audit = async (
    event:
      | "command.refused"
      | "command.approval-required"
      | "command.started"
      | "command.succeeded"
      | "command.failed"
      | "command.unknown",
    details: {
      classification?: "inspect" | "mutation" | "destructive" | "opaque";
      policyDecision: "allowed" | "needs-approval" | "refused";
      reason?: string;
      exitCode?: number;
    },
  ) => {
    if (!options.audit) return;
    await appendLocalAudit(options.audit.inventoryPath, {
      event,
      op: "execute",
      operationId,
      client: options.audit.requester ?? "local-operator",
      ...(options.audit.device ? { device: options.audit.device } : {}),
      ...(options.audit.deviceName
        ? { deviceName: options.audit.deviceName }
        : options.audit.requesterName
          ? { deviceName: options.audit.requesterName }
          : {}),
      host,
      argv: normalizeAuditArgv(options.auditArgv ?? argv),
      ...(details.classification
        ? { classification: details.classification }
        : {}),
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
      policyDecision: details.policyDecision,
      ...([
        "command.started",
        "command.succeeded",
        "command.failed",
        "command.unknown",
      ].includes(event) && options.audit.approver
        ? { approver: options.audit.approver }
        : {}),
    });
  };
  const auditAfterExecution = async (
    event: "command.succeeded" | "command.failed" | "command.unknown",
    details: Parameters<typeof audit>[1],
  ) => {
    try {
      await audit(event, details);
      return undefined;
    } catch {
      const warning =
        "The command ran, but its audit event could not be saved.";
      console.warn(warning);
      return warning;
    }
  };
  const auditRefusal = async (
    event: "command.refused" | "command.approval-required",
    details: Parameters<typeof audit>[1],
  ) => {
    try {
      await audit(event, details);
    } catch {
      console.warn(
        "Could not record the refused command in the audit journal.",
      );
    }
  };
  if (
    !options.dryRun &&
    machine.transport === "local" &&
    machine.access !== "full" &&
    (options.getUid?.() ?? process.getuid?.()) === 0
  ) {
    console.warn(
      "The root-session refusal was not added to the user's audit journal.",
    );
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
      await auditRefusal("command.refused", {
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
  } catch (error) {
    await auditRefusal(
      error instanceof HomectlError && error.code === 4
        ? "command.approval-required"
        : "command.refused",
      {
        classification: plan.classification,
        policyDecision:
          error instanceof HomectlError && error.code === 4
            ? "needs-approval"
            : "refused",
        reason:
          error instanceof HomectlError && error.code === 4
            ? "approval-required"
            : "approval-invalid",
      },
    );
    throw error;
  }
  await options.beforeRun?.();
  const spec = credentialSpec(
    machine.auth,
    transportSpec(machine, argv, options.configPath),
    workerArgv,
  );
  try {
    await audit("command.started", {
      classification: plan.classification,
      policyDecision: plan.needsApproval ? "needs-approval" : "allowed",
    });
  } catch {
    throw new HomectlError(
      5,
      "Command was not run because its redacted start-audit event could not be saved",
    );
  }
  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await (options.runner ?? run)(spec);
  } catch (error) {
    await auditAfterExecution("command.unknown", {
      classification: plan.classification,
      policyDecision: plan.needsApproval ? "needs-approval" : "allowed",
      reason: "execution-outcome-unknown",
    });
    throw error;
  }
  const exitCode =
    Number.isInteger(result.exitCode) &&
    result.exitCode >= 0 &&
    result.exitCode <= 255
      ? result.exitCode
      : undefined;
  const auditWarning = await auditAfterExecution(
    exitCode === 0 ? "command.succeeded" : "command.failed",
    {
      classification: plan.classification,
      policyDecision: plan.needsApproval ? "needs-approval" : "allowed",
      ...(exitCode === undefined ? {} : { exitCode }),
    },
  );
  if (
    machine.auth?.type === "keepassxc" &&
    /homectl SSH session is locked/.test(result.stderr)
  )
    throw new HomectlError(5, probeFailureMessage(result));
  return { plan, result, ...(auditWarning ? { auditWarning } : {}) };
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
