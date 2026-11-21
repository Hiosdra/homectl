// Policy decisions for exec without holding the state lock (homelab #21 §4).
// The policy may call the reviewer, which can take up to its timeout, so the
// broker never awaits it inside BrokerStore.update. exec() works in three steps:
//   1. Under a short lock, record the operation as awaiting review, with the
//      policy revision, client budget and task state it depends on.
//   2. With the lock released, ask the policy.
//   3. Under a short lock again, commit the verdict only if nothing it relied
//      on changed. Otherwise drop it and evaluate again, or after
//      MAX_REVIEW_ATTEMPTS leave the request to the owner.
// While the review runs the operation is visible to the owner, so an owner
// decision wins: the verdict is then dropped and nothing dispatches twice.
import { fingerprint } from "../control/canonical";
import {
  type ActionRequest,
  type PolicyDecision,
  RISK_POINTS,
  type Risk,
  riskAtLeast,
  type TaskRecord,
} from "../core/contracts";
import { HomectlError, type Machine } from "../types";
import { decisionRecord } from "./decision-record";
import type { BrokerStore } from "./store";
import type {
  BrokerOperation,
  BrokerState,
  InventoryPort,
  PolicyPort,
} from "./types";

// An operation whose policy verdict has not been committed yet has the source
// "review" (DecisionSource). This reason text is only read as a fallback, so an
// operation recorded by an earlier build is still recognised as under review.
export const REVIEW_PENDING_REASON =
  "Review in progress; the owner may decide now";
const ENDED_REASON =
  "Ended before the review finished; the reviewer verdict was dropped";
const REVISED_REASON = "The policy changed during review; the owner decides";
export const MAX_REVIEW_ATTEMPTS = 3;

export interface ReviewDeps {
  store: BrokerStore;
  policy: PolicyPort;
  inventory: InventoryPort;
  now: () => number;
  // Client budget window when the policy does not state one.
  windowMs: number;
}

type TaskStatus = "open" | "closed" | "expired";

// What a verdict was computed from. Compared again at commit time.
export interface ReviewSnapshot {
  revision: number;
  now: number;
  clientRiskPoints: number;
  task?: TaskRecord;
  taskStatus?: TaskStatus;
  taskUsed?: TaskRecord["used"];
}

export type Settled =
  // `machine` is set only when the operation starts now (an allow).
  | { kind: "settled"; op: BrokerOperation; machine?: Machine }
  // The operation was decided or ended while the review ran.
  | { kind: "gone"; op: BrokerOperation | undefined };

// True while the decision is the placeholder a running review leaves behind.
export function isReviewPending(
  decision: BrokerOperation["decision"],
): boolean {
  return (
    decision.source === "review" || decision.reason === REVIEW_PENDING_REASON
  );
}

export function isUnderReview(
  op: BrokerOperation | undefined,
): op is BrokerOperation {
  return (
    op !== undefined &&
    op.state === "awaiting-approval" &&
    isReviewPending(op.decision)
  );
}

// The record shown while a review runs. Mirrors what the engine always
// derives for the step-up and human-only flags, so the owner's decide checks
// are correct before the verdict is known. Human-only is R4 (hard gate).
export function pendingDecision(
  risk: Risk,
  revision: number,
): BrokerOperation["decision"] {
  return {
    verdict: "ask",
    source: "review",
    reason: REVIEW_PENDING_REASON,
    stepUp: riskAtLeast(risk, "R3"),
    humanOnly: risk === "R4",
    policyRevision: revision,
    modelCalls: 0,
  };
}

function taskStatusOf(task: TaskRecord, now: number): TaskStatus {
  if (task.state !== "open") return task.state;
  return now >= task.expiresAt ? "expired" : "open";
}

// Client risk points in the budget window, not counting `exceptId`.
function clientRiskOf(
  state: BrokerState,
  client: string,
  now: number,
  windowMs: number,
  exceptId: string,
): number {
  return Object.values(state.operations)
    .filter(
      (o) =>
        o.id !== exceptId &&
        o.client === client &&
        riskAtLeast(o.risk, "R2") &&
        now - o.createdAt < windowMs &&
        o.state !== "denied" &&
        o.state !== "cancelled" &&
        o.state !== "expired",
    )
    .reduce((sum, o) => sum + RISK_POINTS[o.risk], 0);
}

// Reads what a verdict depends on. Expires a task that ran out, as exec always
// did, so the state it stores is current.
export async function captureReview(
  state: BrokerState,
  deps: ReviewDeps,
  client: string,
  taskId: string | undefined,
  exceptId: string,
): Promise<ReviewSnapshot> {
  const now = deps.now();
  let task: TaskRecord | undefined;
  if (taskId !== undefined) {
    task = state.tasks[taskId];
    if (!task || task.client !== client)
      throw new HomectlError(3, "Unknown task");
    if (task.state === "open" && now >= task.expiresAt) task.state = "expired";
  }
  const windowMs = (await deps.policy.budgetWindowMs?.()) ?? deps.windowMs;
  return {
    revision: await deps.policy.revision(),
    now,
    clientRiskPoints: clientRiskOf(state, client, now, windowMs, exceptId),
    ...(task
      ? {
          task: structuredClone(task),
          taskStatus: taskStatusOf(task, now),
          taskUsed: { ...task.used },
        }
      : {}),
  };
}

// Counts the operation against its task once, unless it was denied.
function countTask(state: BrokerState, op: BrokerOperation): void {
  const task = op.task ? state.tasks[op.task] : undefined;
  if (!task || op.state === "denied" || task.operations.includes(op.id)) return;
  task.used.operations += 1;
  task.used.riskPoints += RISK_POINTS[op.risk];
  task.operations.push(op.id);
}

// The operation was decided or ended during the review: keep the owner's
// outcome and drop the verdict. The reviewer's call still counts.
function ended(
  state: BrokerState,
  op: BrokerOperation | undefined,
  modelCalls: number,
): Settled {
  if (op === undefined) return { kind: "gone", op: undefined };
  if (isReviewPending(op.decision))
    op.decision = {
      ...op.decision,
      source: "default",
      reason: ENDED_REASON,
      modelCalls,
    };
  countTask(state, op);
  return { kind: "gone", op };
}

type Commit = Settled | { kind: "stale"; snapshot: ReviewSnapshot };

async function commitVerdict(
  state: BrokerState,
  deps: ReviewDeps,
  id: string,
  fp: string,
  taken: ReviewSnapshot,
  decision: PolicyDecision,
  modelCalls: number,
): Promise<Commit> {
  const op = state.operations[id];
  if (!isUnderReview(op) || op.fingerprint !== fp)
    return ended(state, op, modelCalls);
  const fresh = await captureReview(state, deps, op.client, op.task, id);
  // A verdict made under another revision, or for a task whose state moved
  // on, is stale. An allow also depends on the budgets it was checked against.
  const budgetMoved =
    fresh.clientRiskPoints !== taken.clientRiskPoints ||
    JSON.stringify(fresh.taskUsed) !== JSON.stringify(taken.taskUsed);
  if (
    fresh.revision !== taken.revision ||
    decision.policyRevision !== taken.revision ||
    fresh.taskStatus !== taken.taskStatus ||
    (decision.verdict === "allow" && budgetMoved)
  )
    return { kind: "stale", snapshot: fresh };
  const now = deps.now();
  const machine =
    decision.verdict === "allow"
      ? await deps.inventory.machine(op.host)
      : undefined;
  // The machine policy is checked again at the moment the plan starts.
  const drifted =
    decision.verdict === "allow" &&
    (!machine || fingerprint(machine) !== op.machineHash);
  op.decision = { ...decisionRecord(decision), modelCalls };
  op.updatedAt = now;
  if (drifted) {
    op.state = "failed";
    op.reason = "plan-changed";
    op.finishedAt = now;
  } else if (decision.verdict === "deny") {
    op.state = "denied";
    op.reason = "policy-denied";
    op.finishedAt = now;
  } else if (decision.verdict === "allow") {
    op.state = "dispatching";
    op.startedAt = now;
  }
  countTask(state, op);
  return {
    kind: "settled",
    op,
    ...(op.state === "dispatching" && machine ? { machine } : {}),
  };
}

// The policy kept changing while the request was reviewed. The owner decides
// instead; an ask never runs anything by itself.
async function fallBackToOwner(
  state: BrokerState,
  deps: ReviewDeps,
  id: string,
  fp: string,
  modelCalls: number,
): Promise<Settled> {
  const op = state.operations[id];
  if (!isUnderReview(op) || op.fingerprint !== fp)
    return ended(state, op, modelCalls);
  op.decision = {
    verdict: "ask",
    source: "default",
    reason: REVISED_REASON,
    humanOnly: op.decision.humanOnly,
    stepUp: op.decision.stepUp,
    modelCalls,
    policyRevision: await deps.policy.revision(),
  };
  op.updatedAt = deps.now();
  countTask(state, op);
  return { kind: "settled", op };
}

// Runs the policy with the state lock released, then commits. A commit that
// finds the operation or its inputs changed drops the verdict and starts over
// from a fresh snapshot.
export async function reviewOperation(
  deps: ReviewDeps,
  id: string,
  fp: string,
  request: ActionRequest,
  first: ReviewSnapshot,
): Promise<Settled> {
  let snapshot = first;
  let modelCalls = 0;
  try {
    for (let attempt = 1; ; attempt += 1) {
      const decision = await deps.policy.evaluate(request, {
        ...(snapshot.task ? { task: snapshot.task } : {}),
        clientRiskPoints: snapshot.clientRiskPoints,
        knownHost: true,
        now: snapshot.now,
      });
      modelCalls += decision.modelCalls;
      const commit = await deps.store.update((state) =>
        commitVerdict(state, deps, id, fp, snapshot, decision, modelCalls),
      );
      if (commit.kind !== "stale") return commit;
      if (attempt >= MAX_REVIEW_ATTEMPTS)
        return await deps.store.update((state) =>
          fallBackToOwner(state, deps, id, fp, modelCalls),
        );
      snapshot = commit.snapshot;
    }
  } catch (error) {
    // Nothing the owner has acted on is removed; only a record still waiting
    // for a verdict is dropped, so no half-reviewed operation lingers.
    await deps.store
      .update((state) => {
        if (isUnderReview(state.operations[id])) delete state.operations[id];
      })
      .catch(() => undefined);
    throw error;
  }
}
