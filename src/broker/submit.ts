// Submission of one planned operation: record it awaiting review, run the policy
// (which may call a slow reviewer, never under the state lock), then dispatch it
// if the policy already allowed it. Shared by exec and Proxmox requests, so both
// go through the same review, queue and approval flow. The engine owns the
// public methods; this module owns the steps.
import { randomBytes } from "node:crypto";
import { operationFingerprint } from "./plan";
import {
  captureReview,
  pendingDecision,
  type ReviewDeps,
  reviewOperation,
} from "./review";
import type { BrokerStore } from "./store";
import type {
  BrokerOperation,
  InventoryPort,
  OperationView,
  PolicyPort,
} from "./types";
import type { ActionRequest } from "../core/contracts";
import { HomectlError, type Machine } from "../types";

export const CLIENT_WINDOW_MS = 60 * 60_000;

// What the engine lends to one submission.
export interface SubmitPort {
  store: BrokerStore;
  policy: PolicyPort;
  inventory: InventoryPort;
  now: () => number;
  // How long a request waits for the owner (see approval-wait.ts).
  approvalWaitMs(): Promise<number>;
  emit(
    op: BrokerOperation,
    type: "approval.requested" | "operation.updated",
  ): Promise<void>;
  track(work: Promise<void>): void;
  dispatch(id: string, machine: Machine): Promise<void>;
  view(op: BrokerOperation): OperationView;
}

// Everything about the operation except its id, fingerprint and state.
export type OperationBase = Pick<
  BrokerOperation,
  | "client"
  | "host"
  | "argv"
  | "impact"
  | "classification"
  | "sudo"
  | "risk"
  | "machineHash"
> &
  Partial<
    Pick<
      BrokerOperation,
      "task" | "proxmox" | "providerHash" | "ownerOnly" | "area" | "setup"
    >
  >;

function reviewDeps(port: SubmitPort): ReviewDeps {
  return {
    store: port.store,
    policy: port.policy,
    inventory: port.inventory,
    now: port.now,
    windowMs: CLIENT_WINDOW_MS,
  };
}

export async function submitOperation(
  port: SubmitPort,
  base: OperationBase,
  request: ActionRequest,
  narrative?: string,
): Promise<OperationView> {
  const id = `op_${randomBytes(12).toString("base64url")}`;
  const fp = operationFingerprint({ ...base, id });
  const deps = reviewDeps(port);
  const waitMs = await port.approvalWaitMs();
  const first = await port.store.update(async (state) => {
    const snapshot = await captureReview(
      state,
      deps,
      base.client,
      base.task,
      id,
    );
    state.operations[id] = {
      ...base,
      id,
      fingerprint: fp,
      decision: pendingDecision(base.risk, snapshot.revision),
      state: "awaiting-approval",
      createdAt: snapshot.now,
      expiresAt: snapshot.now + waitMs,
      updatedAt: snapshot.now,
      ...(narrative ? { narrative } : {}),
    };
    return snapshot;
  });
  const settled = await reviewOperation(deps, id, fp, request, first);
  const op = settled.op;
  if (!op) throw new HomectlError(3, "Unknown operation");
  if (settled.kind === "settled")
    await port.emit(
      op,
      op.state === "awaiting-approval"
        ? "approval.requested"
        : "operation.updated",
    );
  // An owner decision made during the review has already dispatched.
  if (settled.kind === "settled" && settled.machine)
    port.track(port.dispatch(id, settled.machine));
  return port.view(op);
}

// Owner-only requests (setup) skip the policy and the reviewer entirely: the
// decision is fixed at planning, so no rule, auto mode or AI helper can reach it.
// The request waits in Needs you and nothing starts until the owner approves.
export async function submitForOwner(
  port: SubmitPort,
  base: OperationBase,
  decision: BrokerOperation["decision"],
  narrative?: string,
): Promise<OperationView> {
  const id = `op_${randomBytes(12).toString("base64url")}`;
  const fp = operationFingerprint({ ...base, id });
  const now = port.now();
  const waitMs = await port.approvalWaitMs();
  const op = await port.store.update((state) => {
    const record: BrokerOperation = {
      ...base,
      id,
      fingerprint: fp,
      decision,
      state: "awaiting-approval",
      createdAt: now,
      expiresAt: now + waitMs,
      updatedAt: now,
      ...(narrative ? { narrative } : {}),
    };
    state.operations[id] = record;
    return record;
  });
  await port.emit(op, "approval.requested");
  return port.view(op);
}
