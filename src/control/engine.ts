import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { loadInventory } from "../inventory";
import { execute as executeCommand } from "../operations";
import { innerCommand, planExecution } from "../policies";
import { run } from "../process";
import {
  HomectlError,
  type Inventory,
  type Machine,
  type Runner,
} from "../types";
import { fingerprint, isoTime } from "./canonical";
import {
  ClientRegistry,
  clientView,
  generateToken,
  hasScope,
  identityOf,
  permitsHost,
  tokenDigest,
  validateClientInput,
} from "./clients";
import { AuditJournal } from "./journal";
import { containsSecretMaterial, redactArgv } from "./redact";
import { schemas } from "./schema";
import { type ControlState, ControlStore } from "./store";
import {
  type Actor,
  type ApprovalRecord,
  type ApprovalView,
  type AuditEvent,
  type AuditEventName,
  type Classification,
  type ClientIdentity,
  type ClientRecord,
  type ClientView,
  CONTROL_API_VERSION,
  type ExecPlan,
  OPERATION_KINDS,
  type OperationKind,
  type OperationRecord,
  type OperationRequest,
  type OperationState,
  type OperationView,
  type Scope,
  TERMINAL_STATES,
} from "./types";

export const PLAN_TTL_MS = 15 * 60_000;
export const APPROVAL_TTL_MS = 5 * 60_000;
export const MAX_OPEN_OPERATIONS = 256;
const SYSTEM_ACTOR = "control-plane";
const LOCAL_ACTOR = "local-operator";
const READ_ONLY = new Set<OperationKind>([
  "inspect",
  "status",
  "validate",
  "verify",
]);
const TERMINAL_EVENTS: Partial<Record<AuditEventName, OperationState>> = {
  "operation.succeeded": "succeeded",
  "operation.failed": "failed",
  "operation.unknown": "unknown",
};

// Executables that take arbitrary commands or escalate privilege. Refused
// for every control-plane plan, whatever the tier.
const NEVER_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "busybox",
  "env",
  "eval",
  "exec",
  "xargs",
  "su",
  "doas",
  "pkexec",
  "chroot",
  "nsenter",
  "unshare",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "socat",
  "telnet",
  "python",
  "python2",
  "python3",
  "perl",
  "ruby",
  "node",
  "bun",
  "awk",
  "gawk",
  "sed",
  "find",
]);
// Container and hypervisor control. Only inspection is allowed through MCP.
const CONTAINER_CONTROL = new Set([
  "docker",
  "podman",
  "nerdctl",
  "ctr",
  "kubectl",
  "qm",
  "pct",
  "pvesh",
]);
const RUNTIME_SOCKET = /docker\.sock|\/run\/podman|\/run\/containerd/i;

type PlanRequest = Extract<OperationRequest, { op: "plan" }>;
type ApproveRequest = Extract<OperationRequest, { op: "approve" }>;

export interface ControlPlaneOptions {
  inventoryPath: string;
  configPath: string;
  stateDirectory: string;
  runner?: Runner;
  clock?: () => number;
}

export interface ExecuteResult {
  operation: OperationView;
  // Returned only to the private local operator; never persisted.
  output?: { stdout: string; stderr: string };
}

function requireScope(client: ClientIdentity, scope: Scope): void {
  if (!hasScope(client, scope))
    throw new HomectlError(3, "Client lacks the scope for this operation");
}

function requireHost(client: ClientIdentity, host: string): void {
  if (!permitsHost(client, host))
    throw new HomectlError(3, "Host not permitted for this client");
}

function machineOf(inventory: Inventory, host: string): Machine | undefined {
  return Object.hasOwn(inventory.machines, host)
    ? inventory.machines[host]
    : undefined;
}

// Unknown and ungranted operations produce the same message.
function visibleOperation(
  state: ControlState,
  client: ClientIdentity,
  operationId: string,
): OperationRecord {
  const op = Object.hasOwn(state.operations, operationId)
    ? state.operations[operationId]
    : undefined;
  if (!op || !permitsHost(client, op.plan.host))
    throw new HomectlError(3, "Operation unavailable");
  return op;
}

function screenPlan(
  argv: string[],
  machine: Machine,
  classification: Classification,
): void {
  if (machine.access === "full")
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
  if (CONTAINER_CONTROL.has(name) && classification !== "inspect")
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
function buildPlan(
  host: string,
  machine: Machine,
  argv: string[],
  impact: string,
): ExecPlan {
  const policy = planExecution(host, machine, argv, impact);
  screenPlan(argv, machine, policy.classification);
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
  };
}

function approvalView(approval: ApprovalRecord): ApprovalView {
  return {
    id: approval.id,
    operationId: approval.operationId,
    fingerprint: approval.fingerprint,
    issuer: approval.issuer,
    approver: approval.approver,
    issuedAt: isoTime(approval.issuedAt),
    expiresAt: isoTime(approval.expiresAt),
    state: approval.state,
  };
}

function operationView(op: OperationRecord, now: number): OperationView {
  const expired =
    (op.state === "pending" && op.expiresAt <= now) ||
    (op.state === "approved" &&
      op.approval !== undefined &&
      op.approval.expiresAt <= now);
  const view: OperationView = {
    operationId: op.id,
    state: op.state,
    host: op.plan.host,
    classification: op.plan.classification,
    needsApproval: op.plan.needsApproval,
    fingerprint: op.fingerprint,
    argv: redactArgv(op.plan.argv),
    impact: op.plan.impact,
    issuer: op.issuer,
    createdAt: isoTime(op.createdAt),
    expiresAt: isoTime(op.expiresAt),
    updatedAt: isoTime(op.updatedAt),
    expired,
    spawnAttempted: op.spawnAttempted,
  };
  if (op.approval) view.approval = approvalView(op.approval);
  if (op.exitCode !== undefined) view.exitCode = op.exitCode;
  if (op.startedAt !== undefined) view.startedAt = isoTime(op.startedAt);
  if (op.finishedAt !== undefined) view.finishedAt = isoTime(op.finishedAt);
  if (op.reason !== undefined) view.reason = op.reason;
  return view;
}

function machineSummary(host: string, machine: Machine) {
  return {
    host,
    description: machine.description,
    transport: machine.transport,
    access: machine.access,
    ...(machine.enforcement ? { enforcement: machine.enforcement } : {}),
    caution: machine.caution ?? [],
  };
}

function failedEvent(
  op: OperationRecord,
  reason: string,
  client = SYSTEM_ACTOR,
): AuditEvent {
  return {
    event: "operation.failed",
    client,
    operationId: op.id,
    host: op.plan.host,
    reason,
  };
}

// Expires stale plans and approvals. Returns the audit events to append.
function sweep(state: ControlState, now: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const op of Object.values(state.operations)) {
    let reason: string | undefined;
    if (op.state === "pending" && op.expiresAt <= now) reason = "plan-expired";
    else if (
      op.state === "approved" &&
      op.approval !== undefined &&
      op.approval.expiresAt <= now
    )
      reason = "approval-expired";
    if (reason === undefined) continue;
    op.state = "failed";
    op.reason = reason;
    op.updatedAt = now;
    events.push(failedEvent(op, reason));
  }
  return events;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function operationKindOf(raw: unknown): OperationKind | undefined {
  const op = (raw as { op?: unknown } | null)?.op;
  return typeof op === "string" &&
    (OPERATION_KINDS as readonly string[]).includes(op)
    ? (op as OperationKind)
    : undefined;
}

// Control-plane engine. Every request is typed, scoped, audited and checked
// against the current inventory. Clients reach it only through the MCP layer;
// the private local operator reaches it through the CLI.
export class ControlPlane {
  readonly store: ControlStore;
  readonly journal: AuditJournal;
  readonly registry: ClientRegistry;
  private readonly clock: () => number;
  private readonly runner: Runner;

  constructor(private readonly options: ControlPlaneOptions) {
    this.clock = options.clock ?? Date.now;
    this.runner = options.runner ?? run;
    this.store = new ControlStore(options.stateDirectory);
    this.journal = new AuditJournal(
      this.store.auditPath,
      this.store.anchorPath,
      this.clock,
    );
    this.registry = new ClientRegistry(this.store.clientsPath);
  }

  // Must run before requests. Creates the private directory and closes
  // operations left `executing` by a process that is no longer alive.
  async init(): Promise<void> {
    await this.store.ensureDirectory();
    await this.store.withLock(async () => {
      const now = this.clock();
      const state = await this.store.loadState();
      for (const op of Object.values(state.operations)) {
        if (op.state !== "executing") continue;
        if (op.executorPid !== undefined && processAlive(op.executorPid))
          continue;
        op.finishedAt = now;
        await this.close(
          state,
          op,
          "unknown",
          "interrupted",
          now,
          [
            {
              event: "operation.unknown",
              client: SYSTEM_ACTOR,
              operationId: op.id,
              host: op.plan.host,
              reason: "interrupted",
            },
          ],
          { spawnAttempted: true },
        );
      }
    });
  }

  // Authentication boundary used by the MCP layer.
  authenticate(credential: string | undefined): Promise<ClientIdentity | null> {
    return this.registry.authenticate(credential);
  }

  async recordAuthRejection(): Promise<void> {
    await this.audit({
      event: "auth.rejected",
      client: SYSTEM_ACTOR,
      reason: "Missing or invalid client credential",
    });
  }

  // Single entry point for typed requests. Rejections are audited with a fixed
  // reason code and then rethrown.
  async request(actor: Actor, raw: unknown): Promise<unknown> {
    const who = actor.kind === "client" ? actor.client.id : LOCAL_ACTOR;
    const kind = operationKindOf(raw);
    try {
      if (!schemas.request(raw))
        throw new HomectlError(2, "Invalid control-plane request");
      const req = raw as OperationRequest;
      const result = await this.dispatch(actor, req);
      if (READ_ONLY.has(req.op))
        await this.audit({
          event: "request.accepted",
          client: who,
          op: req.op,
          ...("operationId" in req && req.operationId !== undefined
            ? { operationId: req.operationId }
            : {}),
        });
      return result;
    } catch (error) {
      const e =
        error instanceof HomectlError
          ? error
          : new HomectlError(
              5,
              "Control-plane request failed; details suppressed",
            );
      await this.audit({
        event: "request.rejected",
        client: who,
        ...(kind ? { op: kind } : {}),
        reason: e.message,
      }).catch(() => undefined);
      throw e;
    }
  }

  // Local operator: create a client. Returns the token once; the caller must
  // write it to a private file and never print it.
  async createClient(
    input: Record<string, unknown>,
  ): Promise<{ client: ClientView; token: string }> {
    const parsed = validateClientInput(input);
    const inventory = await loadInventory(this.options.inventoryPath);
    const unknown = parsed.hosts.filter(
      (host) => !Object.hasOwn(inventory.machines, host),
    );
    if (unknown.length > 0)
      throw new HomectlError(
        2,
        `Unknown inventory host(s): ${unknown.join(", ")}. Valid hosts: ${
          Object.keys(inventory.machines).sort().join(", ") || "none configured"
        }`,
      );
    return this.store.withLock(async () => {
      const now = this.clock();
      const clients = await this.registry.load();
      if (Object.hasOwn(clients, parsed.id))
        throw new HomectlError(2, "Client id already exists");
      const token = generateToken();
      const record: ClientRecord = {
        ...parsed,
        tokenHash: tokenDigest(token).toString("hex"),
        createdAt: now,
      };
      await this.journal.append({ event: "client.created", client: parsed.id });
      clients[parsed.id] = record;
      await this.registry.save(clients);
      return { client: clientView(record), token };
    });
  }

  // Idempotent: revoking an already revoked client reports `changed: false`.
  async revokeClient(
    id: string,
  ): Promise<{ client: ClientView; changed: boolean }> {
    return this.store.withLock(async () => {
      const now = this.clock();
      const clients = await this.registry.load();
      const record = Object.hasOwn(clients, id) ? clients[id] : undefined;
      if (!record) throw new HomectlError(2, "Unknown client");
      const changed = record.revokedAt === undefined;
      if (changed) {
        await this.journal.append({ event: "client.revoked", client: id });
        record.revokedAt = now;
        await this.registry.save(clients);
      }
      return { client: clientView(record), changed };
    });
  }

  async listClients(): Promise<ClientView[]> {
    return Object.values(await this.registry.load())
      .map(clientView)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Local operator views. Read-only: nothing is written, not even audit.
  async listOperations(
    options: { states?: OperationState[]; all?: boolean } = {},
  ): Promise<OperationView[]> {
    const state = await this.store.loadState();
    const now = this.clock();
    const wanted: readonly OperationState[] | undefined =
      options.states ??
      (options.all ? undefined : ["pending", "approved", "executing"]);
    return Object.values(state.operations)
      .filter((op) => wanted === undefined || wanted.includes(op.state))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((op) => operationView(op, now));
  }

  // Full id, or a unique prefix of at least 8 characters.
  async resolveOperation(idOrPrefix: string): Promise<string> {
    const state = await this.store.loadState();
    const ids = Object.keys(state.operations);
    const lower = idOrPrefix.toLowerCase();
    if (Object.hasOwn(state.operations, lower)) return lower;
    if (lower.length < 8)
      throw new HomectlError(
        2,
        "Give at least 8 characters of the operation id",
      );
    const matches = ids.filter((id) => id.startsWith(lower));
    if (matches.length === 0)
      throw new HomectlError(2, "No operation matches that id");
    if (matches.length > 1)
      throw new HomectlError(
        2,
        `Ambiguous id; matches ${matches.map((id) => id.slice(0, 12)).join(", ")}. Use more characters.`,
      );
    return matches[0] ?? lower;
  }

  async showOperation(operationId: string): Promise<OperationView> {
    const state = await this.store.loadState();
    const op = Object.hasOwn(state.operations, operationId)
      ? state.operations[operationId]
      : undefined;
    if (!op) throw new HomectlError(2, "No operation matches that id");
    return operationView(op, this.clock());
  }

  verifyAudit() {
    return this.journal.verify();
  }

  private async audit(event: AuditEvent): Promise<void> {
    await this.store.withLock(() => this.journal.append(event));
  }

  private async dispatch(
    actor: Actor,
    req: OperationRequest,
  ): Promise<unknown> {
    if (actor.kind === "local-operator") {
      if (req.op !== "execute")
        throw new HomectlError(
          3,
          "Local operator requests are limited to execute",
        );
      return this.execute(req.operationId);
    }
    const client = actor.client;
    switch (req.op) {
      case "inspect":
        return this.inspect(client, req.host);
      case "status":
        return this.status(client, req.operationId);
      case "plan":
        return this.plan(client, req);
      case "validate":
        return this.validate(client, req.operationId, req.fingerprint);
      case "approve":
        return this.approve(client, req);
      case "verify":
        return this.verify(client, req.operationId);
      case "execute":
        throw new HomectlError(3, "Execution is a local operator action");
    }
  }

  private async inspect(client: ClientIdentity, host?: string) {
    requireScope(client, "inspect:read");
    const inventory = await loadInventory(this.options.inventoryPath);
    if (host !== undefined) {
      requireHost(client, host);
      const machine = machineOf(inventory, host);
      if (!machine) throw new HomectlError(2, "Unknown host");
      return machineSummary(host, machine);
    }
    return {
      hosts: [...client.hosts].sort().flatMap((name) => {
        const machine = machineOf(inventory, name);
        return machine ? [machineSummary(name, machine)] : [];
      }),
    };
  }

  private async status(client: ClientIdentity, operationId?: string) {
    requireScope(client, "status:read");
    const state = await this.store.loadState();
    const now = this.clock();
    if (operationId !== undefined)
      return operationView(visibleOperation(state, client, operationId), now);
    return {
      client,
      operations: Object.values(state.operations)
        .filter((op) => permitsHost(client, op.plan.host))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50)
        .map((op) => operationView(op, now)),
    };
  }

  private async plan(client: ClientIdentity, req: PlanRequest) {
    requireScope(client, "plan:create");
    requireHost(client, req.host);
    const impact = req.impact ?? "";
    if (containsSecretMaterial(`${req.argv.join("\n")}\n${impact}`))
      throw new HomectlError(
        2,
        "Secret-like material is not accepted in control-plane plans",
      );
    return this.mutate(async (state, now) => {
      const inventory = await loadInventory(this.options.inventoryPath);
      const machine = machineOf(inventory, req.host);
      if (!machine) throw new HomectlError(2, "Unknown host");
      const plan = buildPlan(req.host, machine, req.argv, impact);
      const planFingerprint = fingerprint(plan);
      const key =
        req.idempotencyKey === undefined
          ? undefined
          : `${client.id}:${req.idempotencyKey}`;
      const requestDigest = fingerprint({
        host: req.host,
        argv: req.argv,
        impact,
      });
      if (key !== undefined && Object.hasOwn(state.idempotency, key)) {
        const prior = state.idempotency[key];
        if (prior?.digest !== requestDigest)
          throw new HomectlError(
            3,
            "Idempotency key was already used for a different request",
          );
        const existing = state.operations[prior.operationId];
        if (existing) return operationView(existing, now);
      }
      const open = Object.values(state.operations).filter(
        (op) =>
          op.state === "pending" ||
          op.state === "approved" ||
          op.state === "executing",
      ).length;
      if (open >= MAX_OPEN_OPERATIONS)
        throw new HomectlError(3, "Too many open operations");
      const id = randomUUID();
      const record: OperationRecord = {
        apiVersion: CONTROL_API_VERSION,
        id,
        state: "pending",
        plan,
        fingerprint: planFingerprint,
        issuer: client.id,
        createdAt: now,
        expiresAt: now + PLAN_TTL_MS,
        updatedAt: now,
        spawnAttempted: false,
        ...(req.idempotencyKey !== undefined
          ? { idempotencyKey: req.idempotencyKey }
          : {}),
      };
      await this.journal.append({
        event: "operation.planned",
        client: client.id,
        op: "plan",
        operationId: id,
        host: req.host,
        argv: redactArgv(req.argv),
        fingerprint: planFingerprint,
        classification: plan.classification,
      });
      state.operations[id] = record;
      if (key !== undefined)
        state.idempotency[key] = { digest: requestDigest, operationId: id };
      await this.store.saveState(state);
      return operationView(record, now);
    });
  }

  private async validate(
    client: ClientIdentity,
    operationId: string,
    suppliedFingerprint: string,
  ) {
    requireScope(client, "inspect:read");
    const state = await this.store.loadState();
    const op = visibleOperation(state, client, operationId);
    const reason =
      suppliedFingerprint !== op.fingerprint
        ? "fingerprint-mismatch"
        : fingerprint(op.plan) !== op.fingerprint
          ? "integrity-mismatch"
          : await this.currentReason(op);
    return {
      operationId: op.id,
      state: op.state,
      valid: reason === "ok",
      reason,
    };
  }

  // Re-derives the plan from the current inventory and policy.
  private async currentReason(
    op: OperationRecord,
  ): Promise<"ok" | "host-missing" | "policy-refused" | "machine-changed"> {
    const machine = machineOf(
      await loadInventory(this.options.inventoryPath),
      op.plan.host,
    );
    if (!machine) return "host-missing";
    let fresh: ExecPlan;
    try {
      fresh = buildPlan(op.plan.host, machine, op.plan.argv, op.plan.impact);
    } catch {
      return "policy-refused";
    }
    return fingerprint(fresh) === op.fingerprint ? "ok" : "machine-changed";
  }

  private async approve(client: ClientIdentity, req: ApproveRequest) {
    requireScope(client, "approve:decide");
    return this.mutate(async (state, now) => {
      const op = visibleOperation(state, client, req.operationId);
      if (op.state === "failed" && op.reason === "plan-expired")
        throw new HomectlError(3, "Plan expired; create a new plan");
      if (op.state !== "pending")
        throw new HomectlError(3, "Operation is not awaiting approval");
      if (req.decision === "approve" && !op.plan.needsApproval)
        throw new HomectlError(
          3,
          "Inspection plans need no approval; the local operator can run them with homectl control execute",
        );
      if (req.decision === "approve" && client.id === op.issuer)
        throw new HomectlError(
          3,
          "Self-approval is not permitted; another authorized client must approve",
        );
      if (req.fingerprint !== op.fingerprint)
        throw new HomectlError(
          3,
          "Fingerprint does not match the reviewed plan",
        );
      if (fingerprint(op.plan) !== op.fingerprint) {
        await this.close(state, op, "failed", "integrity-mismatch", now, [
          failedEvent(op, "integrity-mismatch", client.id),
        ]);
        throw new HomectlError(
          3,
          "Stored plan failed integrity check; operation closed",
        );
      }
      if (req.decision === "reject") {
        await this.close(state, op, "failed", "rejected", now, [
          {
            event: "operation.decided",
            client: client.id,
            operationId: op.id,
            decision: "reject",
            fingerprint: op.fingerprint,
          },
          failedEvent(op, "rejected", client.id),
        ]);
        return operationView(op, now);
      }
      const approval: ApprovalRecord = {
        apiVersion: CONTROL_API_VERSION,
        id: randomUUID(),
        operationId: op.id,
        fingerprint: op.fingerprint,
        issuer: op.issuer,
        approver: client.id,
        issuedAt: now,
        expiresAt: now + APPROVAL_TTL_MS,
        nonce: randomBytes(16).toString("hex"),
        state: "active",
      };
      op.approval = approval;
      op.state = "approved";
      op.updatedAt = now;
      await this.journal.append({
        event: "operation.decided",
        client: client.id,
        operationId: op.id,
        decision: "approve",
        fingerprint: op.fingerprint,
        host: op.plan.host,
      });
      await this.store.saveState(state);
      return {
        approval: approvalView(approval),
        operation: operationView(op, now),
      };
    });
  }

  private async verify(client: ClientIdentity, operationId: string) {
    requireScope(client, "status:read");
    const state = await this.store.loadState();
    const op = visibleOperation(state, client, operationId);
    const entries = await this.journal.read();
    const chain = await this.journal.verify();
    const events = entries
      .filter((entry) => entry.event.operationId === op.id)
      .map((entry) => entry.event.event);
    const terminal = [...events]
      .reverse()
      .find((event) => TERMINAL_EVENTS[event] !== undefined);
    let consistent =
      events.includes("operation.planned") &&
      (op.approval === undefined || events.includes("operation.decided")) &&
      (!op.spawnAttempted || events.includes("operation.executing"));
    if ((TERMINAL_STATES as readonly string[]).includes(op.state))
      consistent =
        consistent &&
        terminal !== undefined &&
        TERMINAL_EVENTS[terminal] === op.state;
    else consistent = consistent && terminal === undefined;
    return {
      operationId: op.id,
      state: op.state,
      journal: {
        chainValid: chain.ok,
        entries: chain.entries,
        operationEvents: events.length,
      },
      consistent,
    };
  }

  // Runs a state change under the lock. Expired operations are closed first,
  // and that closure is saved even if the change itself is refused.
  private mutate<T>(
    fn: (state: ControlState, now: number) => Promise<T>,
  ): Promise<T> {
    return this.store.withLock(async () => {
      const now = this.clock();
      const state = await this.store.loadState();
      const swept = sweep(state, now);
      if (swept.length > 0) {
        for (const event of swept) await this.journal.append(event);
        await this.store.saveState(state);
      }
      return fn(state, now);
    });
  }

  // Writes a terminal or recovery transition. Audit events go first, so a
  // failed append leaves the persisted state unchanged.
  private async close(
    state: ControlState,
    op: OperationRecord,
    to: OperationState,
    reason: string | undefined,
    now: number,
    events: AuditEvent[],
    extra: { exitCode?: number; spawnAttempted?: boolean } = {},
  ): Promise<void> {
    for (const event of events) await this.journal.append(event);
    op.state = to;
    op.updatedAt = now;
    if (reason === undefined) delete op.reason;
    else op.reason = reason;
    if (extra.exitCode !== undefined) op.exitCode = extra.exitCode;
    if (extra.spawnAttempted !== undefined)
      op.spawnAttempted = extra.spawnAttempted;
    await this.store.saveState(state);
  }

  private async approverStillAuthorized(
    approverId: string,
    host: string,
  ): Promise<boolean> {
    const clients = await this.registry.load();
    const record = Object.hasOwn(clients, approverId)
      ? clients[approverId]
      : undefined;
    if (!record || record.revokedAt !== undefined) return false;
    const identity = identityOf(record);
    return hasScope(identity, "approve:decide") && permitsHost(identity, host);
  }

  // Local operator only. Approval is re-checked, the nonce is consumed and the
  // state is set to `executing` before any process can start. The runner runs
  // outside the lock, so a crash mid-run leaves `executing`, which recovers as
  // `unknown` and is never retried.
  private async execute(operationId: string): Promise<ExecuteResult> {
    const prepared = await this.mutate(async (state, now) => {
      const op = Object.hasOwn(state.operations, operationId)
        ? state.operations[operationId]
        : undefined;
      if (!op) throw new HomectlError(2, "Unknown operation");
      // Inspection plans (classification `inspect`) cannot change the target and
      // run without a second client; they are still audited and single-use.
      const approvalRequired = op.plan.needsApproval;
      const startState = op.state;
      if (op.state === "pending" && approvalRequired)
        throw new HomectlError(
          4,
          "Operation requires approval before execution",
        );
      if (op.state !== "approved" && op.state !== "pending")
        throw new HomectlError(
          3,
          `Operation is ${op.state}; only approved operations run, and failed or unknown operations are never retried`,
        );
      const approval = approvalRequired ? op.approval : undefined;
      if (
        approvalRequired &&
        (!approval ||
          approval.state !== "active" ||
          state.consumedNonces.includes(approval.nonce))
      )
        throw new HomectlError(3, "Approval was already used");
      if (
        (approval !== undefined && approval.fingerprint !== op.fingerprint) ||
        fingerprint(op.plan) !== op.fingerprint
      ) {
        await this.close(state, op, "failed", "integrity-mismatch", now, [
          failedEvent(op, "integrity-mismatch"),
        ]);
        throw new HomectlError(
          3,
          "Stored plan failed integrity check; operation closed",
        );
      }
      if (
        approval !== undefined &&
        !(await this.approverStillAuthorized(approval.approver, op.plan.host))
      ) {
        await this.close(state, op, "failed", "approval-invalidated", now, [
          failedEvent(op, "approval-invalidated"),
        ]);
        throw new HomectlError(
          3,
          "Approver authority changed; operation closed",
        );
      }
      if ((await this.currentReason(op)) !== "ok") {
        await this.close(state, op, "failed", "stale-plan", now, [
          failedEvent(op, "stale-plan"),
        ]);
        throw new HomectlError(
          3,
          "Machine or command changed since approval; create a fresh plan",
        );
      }
      // Consume the nonce and mark `executing` durably before any spawn.
      if (approval !== undefined) {
        approval.state = "consumed";
        approval.consumedAt = now;
        state.consumedNonces.push(approval.nonce);
      }
      op.state = "executing";
      op.updatedAt = now;
      op.executorPid = process.pid;
      op.startedAt = now;
      op.spawnAttempted = false;
      await this.store.saveState(state);
      try {
        await this.journal.append({
          event: "operation.executing",
          client: LOCAL_ACTOR,
          op: "execute",
          operationId: op.id,
          host: op.plan.host,
          fingerprint: op.fingerprint,
          argv: redactArgv(op.plan.argv),
          classification: op.plan.classification,
          ...(approvalRequired ? {} : { reason: "no-approval-required" }),
        });
      } catch (error) {
        // Nothing has started: restore the previous state and report the failure.
        if (approval !== undefined) {
          approval.state = "active";
          delete approval.consumedAt;
          state.consumedNonces = state.consumedNonces.filter(
            (nonce) => nonce !== approval.nonce,
          );
        }
        op.state = startState;
        op.updatedAt = now;
        delete op.executorPid;
        delete op.startedAt;
        await this.store.saveState(state).catch(() => undefined);
        throw error;
      }
      return {
        host: op.plan.host,
        argv: [...op.plan.argv],
        impact: op.plan.impact,
        approval: op.plan.execApproval,
        machine: structuredClone(op.plan.machine),
      };
    });

    let spawned = false;
    const runner: Runner = (spec) => {
      spawned = true;
      return this.runner(spec);
    };
    let outcome: {
      state: "succeeded" | "failed" | "unknown";
      reason?: string;
      exitCode?: number;
    };
    let output: ExecuteResult["output"];
    try {
      const executed = await executeCommand(
        prepared.host,
        prepared.machine,
        prepared.argv,
        {
          configPath: this.options.configPath,
          approval: prepared.approval,
          impact: prepared.impact,
          runner,
        },
      );
      const result = executed.result;
      if (!result || !Number.isInteger(result.exitCode)) {
        outcome = { state: "unknown", reason: "spawn-outcome-unknown" };
      } else if (result.exitCode === 0) {
        outcome = { state: "succeeded", exitCode: 0 };
      } else {
        outcome = {
          state: "failed",
          reason: "exit-status",
          exitCode: result.exitCode,
        };
      }
      output = result
        ? { stdout: result.stdout, stderr: result.stderr }
        : undefined;
    } catch {
      outcome = spawned
        ? { state: "unknown", reason: "spawn-outcome-unknown" }
        : { state: "failed", reason: "refused-before-spawn" };
    }

    const eventFor: Record<"succeeded" | "failed" | "unknown", AuditEventName> =
      {
        succeeded: "operation.succeeded",
        failed: "operation.failed",
        unknown: "operation.unknown",
      };
    return this.store.withLock(async () => {
      const now = this.clock();
      const state = await this.store.loadState();
      const op = Object.hasOwn(state.operations, operationId)
        ? state.operations[operationId]
        : undefined;
      if (!op || op.state !== "executing")
        throw new HomectlError(
          5,
          "Operation changed during execution; inspect the audit journal",
        );
      op.state = outcome.state;
      op.updatedAt = now;
      op.spawnAttempted = spawned;
      delete op.executorPid;
      op.finishedAt = now;
      if (outcome.reason === undefined) delete op.reason;
      else op.reason = outcome.reason;
      if (outcome.exitCode !== undefined) op.exitCode = outcome.exitCode;
      await this.store.saveState(state);
      try {
        await this.journal.append({
          event: eventFor[outcome.state],
          client: LOCAL_ACTOR,
          operationId: op.id,
          host: op.plan.host,
          fingerprint: op.fingerprint,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.exitCode !== undefined
            ? { exitCode: outcome.exitCode }
            : {}),
        });
      } catch {
        throw new HomectlError(
          5,
          "Outcome recorded but the audit append failed; run homectl control audit verify",
        );
      }
      return { operation: operationView(op, now), output };
    });
  }
}

// Private state directory beside the inventory. Shared by the CLI and the panel.
export function controlStateDirectory(inventoryPath: string): string {
  return join(dirname(resolve(inventoryPath)), "control-plane");
}
