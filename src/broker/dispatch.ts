// Dispatch: the only place that starts a process for an operation. With a
// grant it re-verifies everything at dispatch time (signature, exact plan,
// client, policy revision, step-up, expiry, unchanged machine policy) and
// consumes the nonce exactly once. Nothing is retried.
import { checkGrant } from "../approvals/grant";
import type { NonceLedger } from "../approvals/ledger";
import { fingerprint } from "../control/canonical";
import type { DeviceKey } from "../control/device-key";
import type { ApprovalGrant } from "../core/contracts";
import { HomectlError, type Machine } from "../types";
import { boundOutput } from "./plan";
import type { BrokerStore } from "./store";
import {
  type BrokerOperation,
  type ExecutorPort,
  OUTPUT_LIMIT,
  type PolicyPort,
} from "./types";

export interface DispatchContext {
  store: BrokerStore;
  ledger: NonceLedger;
  key: DeviceKey;
  policy: PolicyPort;
  executor: ExecutorPort;
  now: () => number;
  emit: (op: BrokerOperation) => Promise<void>;
}

export async function dispatch(
  ctx: DispatchContext,
  id: string,
  machine: Machine,
  grant?: ApprovalGrant,
  revision?: number,
): Promise<void> {
  const op = await ctx.store.update(async (state) => {
    const live = state.operations[id];
    if (!live) return undefined;
    if (grant) {
      const now = ctx.now();
      const current = await ctx.policy.revision();
      const check = checkGrant(ctx.key.publicKey, grant, {
        operationId: live.id,
        fingerprint: live.fingerprint,
        client: live.client,
        policyRevision: current,
        stepUpRequired: live.decision.stepUp,
        now,
      });
      const fresh =
        live.state === "awaiting-approval" &&
        check.ok &&
        revision === current &&
        fingerprint(machine) === live.machineHash &&
        (await ctx.ledger.consume(grant.nonce, grant.expiresAt));
      if (!fresh) {
        if (live.state === "awaiting-approval") {
          live.state = "failed";
          live.reason = check.ok
            ? "approval-not-usable"
            : `approval-${check.reason}`;
          live.finishedAt = now;
          live.updatedAt = now;
        }
        return { live, go: false };
      }
      live.state = "dispatching";
      live.startedAt = now;
      live.updatedAt = now;
    } else if (live.state !== "dispatching") {
      return { live, go: false };
    }
    return { live, go: true };
  });
  if (!op) return;
  if (!op.go) {
    await ctx.emit(op.live);
    return;
  }
  let final: Partial<BrokerOperation>;
  try {
    const result = await ctx.executor.run({
      host: op.live.host,
      machine,
      argv: op.live.argv,
      operationId: op.live.id,
    });
    final = {
      state: result.exitCode === 0 ? "succeeded" : "failed",
      result: boundOutput(
        result.exitCode,
        result.stdout,
        result.stderr,
        OUTPUT_LIMIT,
      ),
      ...(result.exitCode === 0 ? {} : { reason: "nonzero-exit" }),
    };
  } catch (error) {
    // A HomectlError is raised before any process starts (locked session,
    // refused worker); anything else may have happened mid-run.
    final =
      error instanceof HomectlError
        ? { state: "failed", reason: "not-started" }
        : { state: "unknown", reason: "executor-interrupted" };
  }
  const done = await ctx.store.update((state) => {
    const live = state.operations[id];
    if (!live) return undefined;
    Object.assign(live, final);
    live.finishedAt = ctx.now();
    live.updatedAt = live.finishedAt;
    return live;
  });
  if (done) await ctx.emit(done);
}
