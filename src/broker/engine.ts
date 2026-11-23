// The broker engine (homelab #21 §4, §7). One instance per device, owned by
// the daemon. Agents call exec/status/wait/cancel/tasks; the owner calls
// decide. Approval and dispatch are one flow: an owner approval issues a
// signed single-use grant and the engine dispatches it immediately after
// verifying and consuming it. Nothing is retried automatically.
import { issueGrant } from "../approvals/grant";
import type { NonceLedger } from "../approvals/ledger";
import { hasScope, permitsHost } from "../control/clients";
import type { DeviceKey } from "../control/device-key";
import type { ClientIdentity } from "../control/types";
import type {
  ActionRequest,
  ApprovalGrant,
  DeviceRef,
} from "../core/contracts";
import { closeTask, openTask } from "../core/tasks";
import { recordVerification } from "../core/verification";
import { HomectlError } from "../types";
import { type DispatchContext, dispatch } from "./dispatch";
import { decisionAudit } from "./decision-record";
import { actionOf, planExec, toView, validateExecInput } from "./plan";
import { planProxmoxRequest } from "./proxmox-submit";
import { approvalRefusal, type CurrentClient } from "./request-authority";
import { isReviewPending, isUnderReview } from "./review";
import { enrolmentConfirmation } from "./setup-decide";
import { planSetupRequest } from "./setup-request";
import type { BrokerStore } from "./store";
import { APPROVAL_WAIT_DEFAULT_MS } from "./approval-wait";
import { type SubmitPort, submitForOwner, submitOperation } from "./submit";
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
  approvalSurface?: string;
  gate?: () => string | undefined;
  currentClient?: CurrentClient;
  approvalWaitMs?: () => Promise<number>;
}

export class Broker {
  private readonly now: () => number;
  private readonly running = new Set<Promise<void>>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly options: BrokerOptions) {
    this.now = options.now ?? Date.now;
  }

  // Startup recovery: work interrupted by a crash has an unknown outcome. A
  // review that was running is gone and nothing ran: the agent resubmits.
  async init(): Promise<void> {
    await this.options.store.update((state) => {
      for (const op of Object.values(state.operations))
        if (op.state === "dispatching") {
          op.state = "unknown";
          op.reason = "interrupted";
          op.finishedAt = this.now();
          op.updatedAt = op.finishedAt;
        } else if (isUnderReview(op)) {
          op.state = "cancelled";
          op.reason = "review-interrupted";
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
      ?.emit(type, op.id, [op.client], decisionAudit(op))
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

  // The policy may call a slow reviewer, so it never runs under the state lock
  // (see review.ts). The operation is recorded first, awaiting review; the
  // verdict is committed only if it still applies.
  async exec(client: ClientIdentity, raw: unknown): Promise<OperationView> {
    const input = validateExecInput(raw);
    if (!hasScope(client, "plan:create") || !permitsHost(client, input.host))
      throw new HomectlError(3, NOT_GRANTED);
    const machine = await this.options.inventory.machine(input.host);
    if (!machine) throw new HomectlError(3, NOT_GRANTED);
    const planned = planExec(input.host, machine, input);
    const base = {
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
    return submitOperation(this.submitPort(), base, request, input.narrative);
  }

  async proxmox(client: ClientIdentity, raw: unknown): Promise<OperationView> {
    const planned = await planProxmoxRequest(
      this.options.inventory,
      client,
      raw,
    );
    return submitOperation(
      this.submitPort(),
      planned.base,
      planned.request,
      planned.narrative,
    );
  }

  // A setup request (scan, probe, enrol, access, preset, remove). Owner-only: it
  // waits in Needs you and never reaches the policy, rules or the reviewer.
  async setupRequest(
    client: ClientIdentity,
    kind: string,
    raw: unknown,
  ): Promise<OperationView> {
    const planned = await planSetupRequest(
      {
        port: this.options.executor.setup,
        inventory: this.options.inventory,
        revision: await this.options.policy.revision(),
        now: this.now,
      },
      client,
      kind,
      raw,
    );
    return submitForOwner(
      this.submitPort(),
      planned.base,
      planned.decision,
      planned.narrative,
    );
  }

  private submitPort(): SubmitPort {
    return {
      store: this.options.store,
      policy: this.options.policy,
      inventory: this.options.inventory,
      now: this.now,
      approvalWaitMs:
        this.options.approvalWaitMs ?? (async () => APPROVAL_WAIT_DEFAULT_MS),
      emit: (op, type) => this.emit(op, type),
      track: (work) => this.track(work),
      dispatch: (id, machine) => dispatch(this.dispatchContext(), id, machine),
      view: (op) => this.view(op, this.options.approvalSurface),
    };
  }

  private dispatchContext(): DispatchContext {
    return {
      ...this.options,
      now: this.now,
      emit: (op) => this.emit(op, "operation.updated"),
    };
  }

  private track(work: Promise<void>) {
    this.running.add(work);
    void work.finally(() => this.running.delete(work));
  }

  private view(op: BrokerOperation, approvalSurface?: string): OperationView {
    const view = toView(op, approvalSurface);
    return op.verification ? { ...view, verification: op.verification } : view;
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
    return this.view(op, this.options.approvalSurface);
  }

  async list(client: ClientIdentity, limit = 50): Promise<OperationView[]> {
    const state = await this.options.store.load();
    return Object.values(state.operations)
      .filter((op) => op.client === client.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map((op) => this.view(op, this.options.approvalSurface));
  }

  // The agent's own check of a finished operation (§7). It records what the
  // agent found; the exit status, state and reason are never changed by it.
  async verify(
    client: ClientIdentity,
    id: string,
    raw: unknown,
  ): Promise<OperationView> {
    const op = await this.options.store.update((state) => {
      const live = state.operations[id];
      if (!live || live.client !== client.id)
        throw new HomectlError(3, "Unknown operation");
      recordVerification(live, raw, this.now());
      return live;
    });
    await this.emit(op, "operation.updated");
    return this.view(op);
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
    return this.view(op);
  }

  async openTask(
    client: ClientIdentity,
    raw: { title?: unknown; ttlMs?: unknown },
  ) {
    const now = this.now();
    return this.options.store.update((state) =>
      openTask(state, client.id, raw, now),
    );
  }

  async closeTask(client: ClientIdentity, id: string) {
    return this.options.store.update((state) =>
      closeTask(state, client.id, id),
    );
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
      const approving =
        input.decision === "approve-once" ||
        input.decision === "approve-remember";
      const reason = await approvalRefusal(
        op,
        state,
        now,
        approving,
        this.options,
      );
      if (reason) {
        Object.assign(op, {
          state: "failed",
          reason,
          finishedAt: now,
          updatedAt: now,
        });
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
        if (
          input.decision === "deny-remember" &&
          this.options.policy.remember &&
          op.proxmox === undefined &&
          op.setup === undefined
        )
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
        const confirmed = enrolmentConfirmation(op, input);
        if (confirmed !== undefined && op.setup !== undefined)
          op.setup.confirmed = confirmed;
        if (input.decision === "approve-remember") {
          // Until the review ends, human-only is not known: no rule from it.
          if (isReviewPending(op.decision))
            throw new HomectlError(
              3,
              "This request is still being reviewed; approve it once or wait for the review",
            );
          if (
            op.decision.humanOnly ||
            op.proxmox !== undefined ||
            !this.options.policy.remember
          )
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
      if (machine || outcome.op.setup !== undefined)
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
      operation: this.view(outcome.op),
      ...(outcome.grant ? { grant: publicGrant as DecideResult["grant"] } : {}),
    };
  }
}
