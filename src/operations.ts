import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendLocalAudit } from "./control/journal";
import { redactArgv } from "./control/redact";
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
export async function execute(
  host: string,
  machine: Machine,
  argv: string[],
  options: {
    configPath: string;
    dryRun?: boolean;
    approval?: string;
    impact?: string;
    requireApproval?: boolean;
    runner?: Runner;
    catalogue?: boolean;
    audit?: {
      inventoryPath: string;
      requester?: string;
      requesterName?: string;
      device?: string;
      deviceName?: string;
      approver?: string;
      operationId?: string;
    };
  },
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
      argv: redactArgv(argv),
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
  let plan: ExecutionPlan;
  try {
    plan = planExecution(host, machine, argv, options.impact, {
      catalogue: options.catalogue === true,
    });
  } catch (error) {
    if (!options.dryRun)
      await audit("command.refused", {
        policyDecision: "refused",
        reason: "policy-refused",
      });
    throw error;
  }
  if (
    options.requireApproval &&
    (plan.classification !== "inspect" || innerCommand(argv).sudo)
  )
    plan.needsApproval = true;
  if (options.dryRun) return { plan };
  try {
    checkApproval(plan, options.approval);
  } catch (error) {
    await audit(
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
  if (
    machine.transport === "local" &&
    machine.access !== "full" &&
    process.getuid?.() === 0
  ) {
    await audit("command.refused", {
      classification: plan.classification,
      policyDecision: "refused",
      reason: "root-session-refused",
    });
    throw new (await import("./types")).HomectlError(
      3,
      "Run homectl as a non-root existing user for non-full local tiers",
    );
  }
  const spec = credentialSpec(
    machine.auth,
    transportSpec(machine, argv, options.configPath),
    workerArgv,
  );
  await audit("command.started", {
    classification: plan.classification,
    policyDecision: plan.needsApproval ? "needs-approval" : "allowed",
  });
  let result: Awaited<ReturnType<Runner>>;
  try {
    result = await (options.runner ?? run)(spec);
  } catch (error) {
    await audit("command.unknown", {
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
  await audit(exitCode === 0 ? "command.succeeded" : "command.failed", {
    classification: plan.classification,
    policyDecision: plan.needsApproval ? "needs-approval" : "allowed",
    ...(exitCode === undefined ? {} : { exitCode }),
  });
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
