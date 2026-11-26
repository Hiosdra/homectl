// Turning a validated agent request into an immutable plan: classification,
// risk and fingerprint. Pure.
import { fingerprint } from "../control/canonical";
import type { ActionRequest, Classification, Risk } from "../core/contracts";
import { innerCommand, planExecution } from "../policies";
import { HomectlError, type Machine } from "../types";
import type { BrokerOperation, ExecInput, OperationView } from "./types";

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const TASK_PATTERN = /^tsk_[A-Za-z0-9_-]{8,64}$/;

export function riskOf(classification: Classification, sudo: boolean): Risk {
  switch (classification) {
    case "inspect":
      return sudo ? "R2" : "R1";
    case "mutation":
      return sudo ? "R3" : "R2";
    case "opaque":
      return "R3";
    case "destructive":
      return "R4";
  }
}

export function validateExecInput(raw: unknown): ExecInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new HomectlError(2, "Request must be a JSON object");
  const input = raw as Record<string, unknown>;
  const allowed = new Set(["host", "argv", "impact", "task", "narrative"]);
  for (const key of Object.keys(input))
    if (!allowed.has(key)) throw new HomectlError(2, `Unknown field: ${key}`);
  const { host, argv, impact, task, narrative } = input;
  if (typeof host !== "string" || !HOST_PATTERN.test(host))
    throw new HomectlError(2, "host must be an inventory host name");
  if (
    !Array.isArray(argv) ||
    argv.length < 1 ||
    argv.length > 64 ||
    argv.some(
      (item) =>
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > 4096 ||
        item.includes("\0"),
    )
  )
    throw new HomectlError(
      2,
      "argv must be 1-64 nonempty strings of at most 4096 characters without NUL",
    );
  if (
    impact !== undefined &&
    (typeof impact !== "string" || impact.length > 1000)
  )
    throw new HomectlError(2, "impact must be text up to 1000 characters");
  if (
    task !== undefined &&
    (typeof task !== "string" || !TASK_PATTERN.test(task))
  )
    throw new HomectlError(2, "task must be a task id");
  if (
    narrative !== undefined &&
    (typeof narrative !== "string" || narrative.length > 2000)
  )
    throw new HomectlError(2, "narrative must be text up to 2000 characters");
  return {
    host,
    argv: argv as string[],
    ...(impact === undefined ? {} : { impact: impact as string }),
    ...(task === undefined ? {} : { task: task as string }),
    ...(narrative === undefined ? {} : { narrative: narrative as string }),
  };
}

export interface PlannedExec {
  classification: Classification;
  sudo: boolean;
  risk: Risk;
  impact: string;
  machineHash: string;
}

// Tier screening reuses the 0.2 policy checks (observe tier, exact sudo
// allowlist, forbidden escalation, Proxmox guest argv refusal).
export function planExec(
  host: string,
  machine: Machine,
  input: ExecInput,
): PlannedExec {
  const plan = planExecution(host, machine, input.argv, input.impact);
  const { sudo } = innerCommand(input.argv);
  return {
    classification: plan.classification,
    sudo,
    risk: riskOf(plan.classification, sudo),
    impact: plan.impact,
    machineHash: fingerprint(machine),
  };
}

export function operationFingerprint(
  op: Pick<
    BrokerOperation,
    | "client"
    | "task"
    | "host"
    | "argv"
    | "impact"
    | "classification"
    | "sudo"
    | "risk"
    | "machineHash"
    | "proxmox"
    | "providerHash"
    | "setup"
  > & { id: string },
): string {
  // Proxmox and setup fields join the fingerprint only when present, so the hash
  // of an exec plan is unchanged. The owner's confirmation is not part of the plan.
  const setup =
    op.setup === undefined
      ? {}
      : {
          setup: {
            kind: op.setup.kind,
            input: op.setup.input,
            presented: op.setup.presented,
          },
        };
  return fingerprint({
    ...setup,
    v: "homectl.plan/v3",
    id: op.id,
    client: op.client,
    task: op.task,
    host: op.host,
    argv: op.argv,
    impact: op.impact,
    classification: op.classification,
    sudo: op.sudo,
    risk: op.risk,
    machineHash: op.machineHash,
    ...(op.proxmox === undefined ? {} : { proxmox: op.proxmox }),
    ...(op.providerHash === undefined ? {} : { providerHash: op.providerHash }),
  });
}

export function boundOutput(
  exitCode: number,
  stdout: string,
  stderr: string,
  limit: number,
) {
  const truncated = stdout.length > limit || stderr.length > limit;
  return {
    exitCode,
    stdout: stdout.length > limit ? stdout.slice(0, limit) : stdout,
    stderr: stderr.length > limit ? stderr.slice(0, limit) : stderr,
    truncated,
  };
}

// The panel link for one operation. The base is the panel origin plus its
// approvals route, for example http://127.0.0.1:7451/#/approvals; the id is
// appended so the link opens that request, not the list.
export function approvalLink(base: string, operationId: string): string {
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(operationId)}`;
}

export function toView(
  op: BrokerOperation,
  approvalSurface?: string,
): OperationView {
  return {
    id: op.id,
    state: op.state,
    host: op.host,
    argv: op.argv,
    classification: op.classification,
    risk: op.risk,
    ...(op.task ? { task: op.task } : {}),
    fingerprint: op.fingerprint,
    decision: {
      verdict: op.decision.verdict,
      source: op.decision.source,
      reason: op.decision.reason,
    },
    createdAt: new Date(op.createdAt).toISOString(),
    expiresAt: new Date(op.expiresAt).toISOString(),
    ...(op.finishedAt
      ? { finishedAt: new Date(op.finishedAt).toISOString() }
      : {}),
    ...(op.result ? { result: op.result } : {}),
    ...(op.reason ? { reason: op.reason } : {}),
    ...(op.state === "awaiting-approval" && approvalSurface
      ? { approvalSurface: approvalLink(approvalSurface, op.id) }
      : {}),
  };
}

export function actionOf(op: BrokerOperation): ActionRequest {
  return {
    client: op.client,
    ...(op.task ? { task: op.task } : {}),
    kind: op.proxmox === undefined ? "exec" : "proxmox",
    host: op.host,
    argv: op.argv,
    sudo: op.sudo,
    classification: op.classification,
    risk: op.risk,
    ...(op.narrative ? { narrative: op.narrative } : {}),
  };
}
