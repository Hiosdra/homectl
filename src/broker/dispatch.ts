// Dispatch: the only place that starts a process for an operation. With a
// grant it re-verifies everything at dispatch time (signature, exact plan,
// client, policy revision, step-up, expiry, unchanged machine policy) and
// consumes the nonce exactly once. Nothing is retried.
import { checkGrant } from "../approvals/grant";
import type { NonceLedger } from "../approvals/ledger";
import { fingerprint } from "../control/canonical";
import type { DeviceKey } from "../control/device-key";
import type { ApprovalGrant } from "../core/contracts";
import { HomectlError, type Machine, type ProcessResult } from "../types";
import { boundOutput } from "./plan";
import { authorityRefusal, type CurrentClient } from "./request-authority";
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
  // Returns a reason when nothing may start now (vault locked); checked
  // before the nonce is consumed so a locked vault never burns a grant.
  gate?: () => string | undefined;
  currentClient?: CurrentClient;
}

// Proxmox requests run through the API transport, never over SSH. Without one,
// nothing starts and the operation fails as not-started.
async function runProxmox(
  executor: ExecutorPort,
  op: BrokerOperation,
): Promise<ProcessResult> {
  if (!executor.proxmox || op.proxmox === undefined)
    throw new HomectlError(
      5,
      "The Proxmox API is not configured for this broker",
    );
  return executor.proxmox.run({
    host: op.host,
    operationId: op.id,
    request: op.proxmox,
    ...(op.providerHash === undefined ? {} : { providerHash: op.providerHash }),
  });
}

// Setup requests run through the owner's setup routes, which re-check their own
// inputs (a changed machine or key fails there, with a plain reason).
async function runSetup(
  executor: ExecutorPort,
  op: BrokerOperation,
  reviewerApiKey: string | undefined,
): Promise<ProcessResult> {
  if (!executor.setup || op.setup === undefined)
    throw new HomectlError(
      5,
      "Setup requests are not available on this broker",
    );
  return executor.setup.run({
    kind: op.setup.kind,
    input: { ...op.setup.input },
    ...(reviewerApiKey === undefined ? {} : { reviewerApiKey }),
    ...(op.setup.confirmed === undefined
      ? {}
      : { confirmFingerprint: op.setup.confirmed }),
    ...(op.setup.presented === undefined
      ? {}
      : { presented: op.setup.presented }),
  });
}

// Exec runs over SSH on the machine the plan named; without it nothing starts.
async function runExec(
  executor: ExecutorPort,
  op: BrokerOperation,
  machine: Machine | undefined,
): Promise<ProcessResult> {
  if (!machine) throw new HomectlError(3, "The machine is not in the list");
  return executor.run({
    host: op.host,
    machine,
    argv: op.argv,
    operationId: op.id,
  });
}

export async function dispatch(
  ctx: DispatchContext,
  id: string,
  machine: Machine | undefined,
  grant?: ApprovalGrant,
  revision?: number,
  reviewerApiKey?: string,
): Promise<void> {
  const op = await ctx.store.update(async (state) => {
    const live = state.operations[id];
    if (!live) return undefined;
    const now = ctx.now();
    const closed =
      ctx.gate?.() ??
      (await authorityRefusal(live, state, now, ctx.currentClient));
    if (
      closed !== undefined &&
      (live.state === "dispatching" ||
        (grant !== undefined && live.state === "awaiting-approval"))
    ) {
      live.state = "failed";
      live.reason = closed;
      live.finishedAt = now;
      live.updatedAt = now;
      return { live, go: false };
    }
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
        live.grantId === grant.id &&
        now < live.expiresAt &&
        check.ok &&
        revision === current &&
        fingerprint(machine ?? null) === live.machineHash &&
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
    const result =
      op.live.setup !== undefined
        ? await runSetup(ctx.executor, op.live, reviewerApiKey)
        : op.live.proxmox !== undefined
          ? await runProxmox(ctx.executor, op.live)
          : await runExec(ctx.executor, op.live, machine);
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
