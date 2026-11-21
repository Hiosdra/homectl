// Guest and generic exec plans: the existing policy decides tier and
// classification, and the control plane screens the result on top. Moved out of
// engine.ts unchanged to keep that file within its length baseline.
import { basename } from "node:path";
import { innerCommand, planExecution } from "../policies";
import { HomectlError, type Machine } from "../types";
import {
  CONTAINER_CONTROL,
  NEVER_EXECUTABLES,
  RUNTIME_SOCKET,
} from "./policy-constants";
import {
  CONTROL_API_VERSION,
  type Classification,
  type ExecPlan,
} from "./types";

export function screenPlan(
  argv: string[],
  machine: Machine,
  classification: Classification,
  catalogue = false,
): void {
  // Proxmox guest plans from the catalogue are the one reviewed path to qm/pct.
  if (machine.access === "full" && !catalogue)
    throw new HomectlError(
      3,
      "Full-access hosts are not available through the control plane",
    );
  const name = basename(innerCommand(argv).args[0] ?? "");
  if (
    NEVER_EXECUTABLES.has(basename(argv[0] ?? "")) ||
    NEVER_EXECUTABLES.has(name)
  )
    throw new HomectlError(
      3,
      "Shell, interpreter and privilege-wrapper commands are not available through the control plane",
    );
  if (argv.some((value) => RUNTIME_SOCKET.test(value)))
    throw new HomectlError(
      3,
      "Container runtime sockets are not available through the control plane",
    );
  if (CONTAINER_CONTROL.has(name) && classification !== "inspect" && !catalogue)
    throw new HomectlError(
      3,
      "Container and hypervisor control is limited to inspection through the control plane",
    );
  if (classification === "opaque")
    throw new HomectlError(
      3,
      "Opaque commands are not available through the control plane",
    );
}

// Builds the immutable plan. The existing policy decides tier and
// classification; the control plane adds screening on top.
export function buildPlan(
  host: string,
  machine: Machine,
  argv: string[],
  impact: string,
  catalogue = false,
): ExecPlan {
  const policy = planExecution(host, machine, argv, impact, { catalogue });
  screenPlan(argv, machine, policy.classification, catalogue);
  return {
    apiVersion: CONTROL_API_VERSION,
    kind: "exec",
    host,
    machine: structuredClone(machine),
    argv: [...argv],
    impact: policy.impact,
    classification: policy.classification,
    // Only inspection is exempt; the existing policy flag does not cover mutation.
    needsApproval: policy.classification !== "inspect",
    execApproval: policy.approval,
    ...(catalogue ? { catalogue: true } : {}),
  };
}
