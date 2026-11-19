// The broker engine (homelab #21 §4, §7). One instance per device, owned by
// the daemon. Agents call exec/status/wait/cancel/tasks; the owner calls
// decide. Approval and dispatch are one flow: an owner approval issues a
// signed single-use grant and the engine dispatches it immediately after
// verifying and consuming it. Nothing is retried automatically.
import { randomBytes } from "node:crypto";
import { issueGrant } from "../approvals/grant";
import type { NonceLedger } from "../approvals/ledger";
import { fingerprint } from "../control/canonical";
import { hasScope, permitsHost } from "../control/clients";
import type { DeviceKey } from "../control/device-key";
import type { ClientIdentity } from "../control/types";
import {
  type ActionRequest,
  type ApprovalGrant,
  type DeviceRef,
  RISK_POINTS,
  riskAtLeast,
  type TaskRecord,
} from "../core/contracts";
import { HomectlError } from "../types";
import { type DispatchContext, dispatch } from "./dispatch";
import {
  actionOf,
  operationFingerprint,
  planExec,
  toView,
  validateExecInput,
} from "./plan";
import type { BrokerStore } from "./store";
import {
  type BrokerOperation,
  type DecideInput,
  type DecideResult,
  type EventsPort,
  type ExecutorPort,
  FINAL_STATES,
  type InventoryPort,
  type OperationView,
  type PolicyPort,
} from "./types";

export const PLAN_TTL_MS = 15 * 60_000;
export const CLIENT_WINDOW_MS = 60 * 60_000;
export const MAX_TASK_TTL_MS = 24 * 60 * 60_000;
// Same text for unknown and ungranted hosts: no enumeration.
const NOT_GRANTED = "Host is not in this client's grants";

export interface BrokerOptions {
  store: BrokerStore;
  ledger: NonceLedger;
  key: DeviceKey;
  device: DeviceRef;
  policy: PolicyPort;
  inventory: InventoryPort;
  executor: ExecutorPort;
  events?: EventsPort;
  now?: () => number;
  // Shown to agents so they can tell the user where to approve.
  approvalSurface?: string;
  // See DispatchContext.gate.
  gate?: () => string | undefined;
}

export class Broker {
  private readonly now: () => number;
  private readonly running = new Set<Promise<void>>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly options: BrokerOptions) {
    this.now = options.now ?? Date.now;
  }

  // Startup recovery: work interrupted by a crash has an unknown outcome.
  async init(): Promise<void> {
    await this.options.store.update((state) => {
      for (const op of Object.values(state.operations))
        if (op.state === "dispatching") {
          op.state = "unknown";
          op.reason = "interrupted";
          op.finishedAt = this.now();
          op.updatedAt = op.finishedAt;
        }
    });
  }

  // Resolves when every dispatch started so far has finished (tests, shutdown).
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private notify(id: string) {
    for (const wake of this.waiters.get(id) ?? []) wake();
    this.waiters.delete(id);
  }

  private async emit(
    op: BrokerOperation,
    type: "approval.requested" | "operation.updated",
  ) {
    await this.options.events
      ?.emit(type, op.id, [op.client], {
        state: op.state,
        host: op.host,
        risk: op.risk,
        client: op.client,
      })
      .catch(() => undefined);
    this.notify(op.id);
  }

  private expire(op: BrokerOperation, now: number): boolean {
    if (op.state !== "awaiting-approval" || now < op.expiresAt) return false;
    op.state = "expired";
    op.reason = "approval-window-elapsed";
    op.finishedAt = now;
    op.updatedAt = now;
    return true;
  }

  // ---------------------------------------------------------------- agent

  async exec(client: ClientIdentity, raw: unknown): Promise<OperationView> {
    const input = validateExecInput(raw);
    if (!hasScope(client, "plan:create") || !permitsHost(client, input.host))
      throw new HomectlError(3, NOT_GRANTED);
    const machine = await this.options.inventory.machine(input.host);
    if (!machine) throw new HomectlError(3, NOT_GRANTED);
    const planned = planExec(input.host, machine, input);
    const now = this.now();
    const op = await this.options.store.update(async (state) => {
      let task: TaskRecord | undefined;
      if (input.task) {
        task = state.tasks[input.task];
        if (!task || task.client !== client.id)
          throw new HomectlError(3, "Unknown task");
        if (task.state === "open" && now >= task.expiresAt)
          task.state = "expired";
      }
      const window =
        (await this.options.policy.budgetWindowMs?.()) ?? CLIENT_WINDOW_MS;
      const clientRiskPoints = Object.values(state.operations)
        .filter(
          (o) =>
            o.client === client.id &&
            riskAtLeast(o.risk, "R2") &&
            now - o.createdAt < window &&
            o.state !== "denied" &&
            o.state !== "cancelled" &&
            o.state !== "expired",
        )
        .reduce((sum, o) => sum + RISK_POINTS[o.risk], 0);
      const id = `op_${randomBytes(12).toString("base64url")}`;
      const base = {
        id,
        client: client.id,
        ...(input.task ? { task: input.task } : {}),
        host: input.host,
        argv: input.argv,
        impact: planned.impact,
        classification: planned.classification,
        sudo: planned.sudo,
        risk: planned.risk,
        machineHash: planned.machineHash,
      };
      const request: ActionRequest = {
        client: client.id,
        ...(input.task ? { task: input.task } : {}),
        kind: "exec",
        host: input.host,
        argv: input.argv,
        sudo: planned.sudo,
        classification: planned.classification,
        risk: planned.risk,
        ...(input.narrative ? { narrative: input.narrative } : {}),
      };
      const decision = await this.options.policy.evaluate(request, {
        ...(task ? { task } : {}),
        clientRiskPoints,
        knownHost: true,
        now,
      });
      const record: BrokerOperation = {
        ...base,
        fingerprint: operationFingerprint(base),
        decision: {
          verdict: decision.verdict,
          source: decision.source,
          reason: decision.reason,
          stepUp: decision.stepUp,
          humanOnly: decision.humanOnly,
          policyRevision: decision.policyRevision,
          ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
        },
        state:
          decision.verdict === "deny"
            ? "denied"
            : decision.verdict === "ask"
              ? "awaiting-approval"
              : "dispatching",
        createdAt: now,
        expiresAt: now + PLAN_TTL_MS,
        updatedAt: now,
        ...(input.narrative ? { narrative: input.narrative } : {}),
        ...(decision.verdict === "deny"
          ? { finishedAt: now, reason: "policy-denied" }
          : {}),
        ...(decision.verdict === "allow" ? { startedAt: now } : {}),
      };
      state.operations[id] = record;
      if (task && record.state !== "denied") {
        task.used.operations += 1;
        task.used.riskPoints += RISK_POINTS[record.risk];
        task.operations.push(id);
      }
      return record;
    });
    await this.emit(
      op,
      op.state === "awaiting-approval"
        ? "approval.requested"
        : "operation.updated",
    );
    if (op.state === "dispatching")
      this.track(dispatch(this.dispatchContext(), op.id, machine));
    return toView(op, this.options.approvalSurface);
  }

  private dispatchContext(): DispatchContext {
    return {
      store: this.options.store,
      ledger: this.options.ledger,
      key: this.options.key,
      policy: this.options.policy,
      executor: this.options.executor,
      now: this.now,
      emit: (op) => this.emit(op, "operation.updated"),
      ...(this.options.gate ? { gate: this.options.gate } : {}),
    };
  }

  private track(work: Promise<void>) {
    this.running.add(work);
    void work.finally(() => this.running.delete(work));
  }

  async status(client: ClientIdentity, id: string): Promise<OperationView> {
    const state = await this.options.store.load();
    const op = state.operations[id];
    if (!op || op.client !== client.id)
      throw new HomectlError(3, "Unknown operation");
    if (this.expire(op, this.now()))
      await this.options.store.update((s) => {
        const live = s.operations[id];
        if (live) this.expire(live, this.now());
      });
    return toView(op, this.options.approvalSurface);
  }

  async list(client: ClientIdentity, limit = 50): Promise<OperationView[]> {
    const state = await this.options.store.load();
    return Object.values(state.operations)
      .filter((op) => op.client === client.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map((op) => toView(op, this.options.approvalSurface));
  }

  // Blocks until the operation is final or the timeout passes. Waiting is not
  // a retry: it never re-dispatches anything.
  async wait(
    client: ClientIdentity,
    id: string,
    timeoutMs: number,
  ): Promise<OperationView> {
    const deadline = this.now() + Math.min(Math.max(timeoutMs, 0), 600_000);
    for (;;) {
      const view = await this.status(client, id);
      if (FINAL_STATES.includes(view.state) || this.now() >= deadline)
        return view;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.min(1000, deadline - this.now()),
        );
        const set = this.waiters.get(id) ?? new Set();
        set.add(() => {
          clearTimeout(timer);
          resolve();
        });
        this.waiters.set(id, set);
      });
    }
  }

  async cancel(client: ClientIdentity, id: string): Promise<OperationView> {
    const op = await this.options.store.update((state) => {
      const live = state.operations[id];
      if (!live || live.client !== client.id)
        throw new HomectlError(3, "Unknown operation");
      if (live.state !== "awaiting-approval")
        throw new HomectlError(
          3,
          "Only operations awaiting approval can be cancelled",
        );
      live.state = "cancelled";
      live.reason = "cancelled-by-client";
      live.finishedAt = this.now();
      live.updatedAt = live.finishedAt;
      return live;
    });
    await this.emit(op, "operation.updated");
    return toView(op);
  }

  async openTask(
    client: ClientIdentity,
    raw: { title?: unknown; ttlMs?: unknown },
  ): Promise<TaskRecord> {
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title || title.length > 200)
      throw new HomectlError(2, "Task title must be 1-200 characters");
    const ttl =
      typeof raw.ttlMs === "number" && Number.isSafeInteger(raw.ttlMs)
        ? Math.min(Math.max(raw.ttlMs, 60_000), MAX_TASK_TTL_MS)
        : 4 * 60 * 60_000;
    const now = this.now();
    const task: TaskRecord = {
      id: `tsk_${randomBytes(12).toString("base64url")}`,
      client: client.id,
      title,
      createdAt: now,
      expiresAt: now + ttl,
      state: "open",
      used: { operations: 0, riskPoints: 0 },
      operations: [],
    };
    await this.options.store.update((state) => {
      const open = Object.values(state.tasks).filter(
        (t) => t.client === client.id && t.state === "open",
      );
      if (open.length >= 32)
        throw new HomectlError(3, "Too many open tasks; close some first");
      state.tasks[task.id] = task;
    });
    return task;
  }

  async closeTask(client: ClientIdentity, id: string): Promise<TaskRecord> {
    return this.options.store.update((state) => {
      const task = state.tasks[id];
      if (!task || task.client !== client.id)
        throw new HomectlError(3, "Unknown task");
      task.state = "closed";
      return task;
    });
  }

  // ---------------------------------------------------------------- owner

  // Vault lock: nothing queued survives it; agents resubmit after unlock.
  async invalidatePending(reason: string): Promise<number> {
    const now = this.now();
    const changed = await this.options.store.update((state) => {
      const ops = Object.values(state.operations).filter(
        (op) => op.state === "awaiting-approval",
      );
      for (const op of ops)
        Object.assign(op, {
          state: "cancelled",
          reason,
          finishedAt: now,
          updatedAt: now,
        });
      return ops;
    });
    for (const op of changed) await this.emit(op, "operation.updated");
    return changed.length;
  }

  async pending(): Promise<BrokerOperation[]> {
    const now = this.now();
    const state = await this.options.store.load();
    return Object.values(state.operations)
      .filter((op) => op.state === "awaiting-approval" && now < op.expiresAt)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async operation(id: string): Promise<BrokerOperation | undefined> {
    return (await this.options.store.load()).operations[id];
  }

  // Called only by an owner surface after it authenticated the owner.
  async decide(input: DecideInput): Promise<DecideResult> {
    const now = this.now();
    let revision = await this.options.policy.revision();
    const outcome = await this.options.store.update(async (state) => {
      const op = state.operations[input.operationId];
      if (!op) throw new HomectlError(3, "Unknown operation");
      if (this.expire(op, now))
        return { op, grant: undefined as ApprovalGrant | undefined };
      if (op.state !== "awaiting-approval")
        throw new HomectlError(3, "This operation was already decided");
      if (op.fingerprint !== input.fingerprint)
        throw new HomectlError(3, "The plan changed; review it again");
      const machine = await this.options.inventory.machine(op.host);
      if (!machine || fingerprint(machine) !== op.machineHash) {
        op.state = "failed";
        op.reason = "plan-changed";
        op.finishedAt = now;
        op.updatedAt = now;
        return { op, grant: undefined };
      }
      if (input.decision === "revise") {
        op.state = "cancelled";
        op.reason = "revision-requested";
      } else if (
        input.decision === "deny-once" ||
        input.decision === "deny-remember"
      ) {
        op.state = "denied";
        op.reason = "owner-denied";
        if (input.decision === "deny-remember" && this.options.policy.remember)
          op.rememberedRule = await this.options.policy.remember(
            actionOf(op),
            "deny",
          );
      } else {
        if (op.decision.stepUp && !input.stepUp)
          throw new HomectlError(
            3,
            "This approval needs you to confirm your identity again",
          );
        if (input.decision === "approve-remember") {
          if (op.decision.humanOnly || !this.options.policy.remember)
            throw new HomectlError(
              3,
              "This kind of action cannot be remembered as a rule; approve it once",
            );
          op.rememberedRule = await this.options.policy.remember(
            actionOf(op),
            "allow",
          );
          // Saving the rule bumped the policy revision; bind the grant to it.
          revision = await this.options.policy.revision();
        }
        const grant = issueGrant(this.options.key, {
          operationId: op.id,
          fingerprint: op.fingerprint,
          client: op.client,
          host: op.host,
          policyRevision: revision,
          device: this.options.device.id,
          surface: input.surface,
          stepUp: input.stepUp,
          ...(op.rememberedRule ? { ruleId: op.rememberedRule } : {}),
          now,
        });
        op.grantId = grant.id;
        op.approvedBy = {
          surface: input.surface,
          stepUp: input.stepUp,
          at: now,
        };
        op.updatedAt = now;
        return { op, grant };
      }
      op.finishedAt = now;
      op.updatedAt = now;
      return { op, grant: undefined };
    });
    await this.emit(outcome.op, "operation.updated");
    if (outcome.grant) {
      const machine = await this.options.inventory.machine(outcome.op.host);
      if (machine)
        this.track(
          dispatch(
            this.dispatchContext(),
            outcome.op.id,
            machine,
            outcome.grant,
            revision,
          ),
        );
    }
    const {
      signature: _s,
      nonce: _n,
      ...publicGrant
    } = outcome.grant ?? {
      signature: "",
      nonce: "",
    };
    return {
      operation: toView(outcome.op),
      ...(outcome.grant ? { grant: publicGrant as DecideResult["grant"] } : {}),
    };
  }
}
