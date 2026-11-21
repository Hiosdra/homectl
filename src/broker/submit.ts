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

export const PLAN_TTL_MS = 15 * 60_000;
export const CLIENT_WINDOW_MS = 60 * 60_000;

// What the engine lends to one submission.
export interface SubmitPort {
  store: BrokerStore;
  policy: PolicyPort;
  inventory: InventoryPort;
  now: () => number;
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
      "task" | "proxmox" | "providerHash" | "ownerOnly" | "area"
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
      expiresAt: snapshot.now + PLAN_TTL_MS,
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
