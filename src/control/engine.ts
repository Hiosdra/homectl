import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadInventory } from "../inventory";
import { execute as executeCommand, writeSSHConfig } from "../operations";
import { innerCommand, planExecution } from "../policies";
import { run } from "../process";
import {
  buildProxmoxPlan,
  type ProxmoxInput,
  providerFacts,
} from "../proxmox/catalogue";
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
import {
  type Fetcher,
  identityHash,
  issuerHost,
  JwksSource,
  type JwksStatus,
  looksLikeJwt,
  MAX_LIFETIME_SECONDS,
  type OidcConfig,
  OidcRefusal,
  printableText,
  RejectionLimiter,
  TokenAuditCache,
  tokenIdentityKey,
  validateOidcConfigInput,
  verifyOidcToken,
} from "./oidc";
import { containsSecretMaterial, redactArgv } from "./redact";
import type { ReplicaOverlay } from "./replicator";
import { schemas } from "./schema";
import { type ControlState, ControlStore } from "./store";
import {
  type Actor,
  type ApprovalRecord,
  type ApprovalView,
  type AuditEvent,
  type AuditEventName,
  type CatalogueInput,
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
  // Replication gate (ADR-0002, fencing rule). Returns a refusal reason, or
  // undefined when this device may run the operation right now.
  fence?: (
    operationId: string,
  ) => string | undefined | Promise<string | undefined>;
  // Replicated view: owners, delivery of forwarded approvals, operations held
  // only by other devices (ADR-0002 stage d).
  replicaOverlay?: (localIds: Set<string>) => Promise<ReplicaOverlay>;
  // Transport for JWKS and discovery. Defaults to fetch; tests may inject one.
  oidcFetch?: Fetcher;
  // Authority of an approver whose registration lives on another device.
  // Authority of an approver registered on another device. undefined means it
  // cannot be determined here; the operation then stays as it is.
  approverAuthorized?: (
    approverId: string,
    host: string,
  ) => boolean | undefined;
  // Forwards an approval for an operation owned by another device.
  remoteDecision?: (
    client: ClientIdentity,
    req: ApproveRequest,
  ) => Promise<unknown>;
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
function buildPlan(
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
    ...(op.plan.catalogueInput
      ? { catalogueInput: op.plan.catalogueInput }
      : {}),
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

// One id per process start. An executing record written by this incarnation is
// alive by definition; a record from another incarnation that reused this pid is not.
const PROCESS_INSTANCE = randomUUID();

// A record left "executing" is still alive only if its executor is this
// incarnation, or a different process whose pid is alive. A different
// incarnation that reused this process's pid is not alive. A foreign live pid
// is kept as alive: its instance cannot be observed from here, and recovering a
// running executor as unknown would misreport it.
function executorAlive(op: OperationRecord): boolean {
  if (op.executorPid === undefined) return false;
  if (op.executorInstance === PROCESS_INSTANCE) return true;
  if (op.executorPid === process.pid) return false;
  return processAlive(op.executorPid);
}

// Rebuilds a catalogue argv from the typed input against the inventory facts in
// force now. undefined when the current facts refuse it (provider removed, VMID
// outside the range, a protected VMID, a storage or template no longer allowed).
function catalogueArgvNow(
  inventory: Inventory,
  host: string,
  machine: Machine,
  input: CatalogueInput | undefined,
): { argv: string[]; label: string } | undefined {
  if (!input) return undefined;
  const provider = Object.values(inventory.providers ?? {}).find(
    (candidate) => candidate.host === host,
  );
  if (!provider) return undefined;
  try {
    const built = buildProxmoxPlan(
      input as ProxmoxInput,
      providerFacts(provider),
    );
    return {
      argv:
        machine.user === "root" ? built.argv : ["sudo", "-n", ...built.argv],
      label: built.label,
    };
  } catch {
    return undefined;
  }
}

// Takeover of a catalogue operation: the receiving device rebuilds the plan from
// its own facts. Refused when they do not allow it, or when they describe the guest
// differently from the planning device (the fingerprint then differs).
function catalogueAdoptionPlan(
  input: { host: string; catalogueInput: CatalogueInput; fingerprint?: string },
  inventory: Inventory,
  machine: Machine,
): ExecPlan {
  const now = catalogueArgvNow(
    inventory,
    input.host,
    machine,
    input.catalogueInput,
  );
  if (!now)
    throw new HomectlError(
      3,
      `This device's inventory does not allow this Proxmox operation for ${input.host}; takeover refused. Plan the operation again on a device whose inventory allows it.`,
    );
  const plan = buildPlan(input.host, machine, now.argv, now.label, true);
  plan.catalogueInput = structuredClone(input.catalogueInput);
  if (
    input.fingerprint !== undefined &&
    fingerprint(plan) !== input.fingerprint
  )
    throw new HomectlError(
      3,
      `This device describes the guest for ${input.host} differently from the planning device (machine or Proxmox provider settings); takeover refused. Plan the operation again.`,
    );
  return plan;
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
  private readonly oidcSources = new Map<string, JwksSource>();
  // One audit entry per token, and one per window for identical refusals.
  private readonly oidcAuditSeen = new TokenAuditCache();
  private readonly rejectionLimiter = new RejectionLimiter();
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
        if (executorAlive(op)) continue;
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
  // Static "hct_" tokens are unchanged. A JWT-shaped token takes the OIDC path
  // when OIDC is configured; anything else is refused.
  authenticate(credential: string | undefined): Promise<ClientIdentity | null> {
    if (typeof credential === "string" && credential.startsWith("hct_"))
      return this.registry.authenticate(credential);
    if (typeof credential === "string" && looksLikeJwt(credential))
      return this.authenticateOidc(credential);
    return this.registry.authenticate(credential);
  }

  // OIDC configuration lives beside the control state. It holds no secrets.
  private get oidcPath(): string {
    return join(this.options.stateDirectory, "oidc.json");
  }

  async loadOidc(): Promise<OidcConfig | undefined> {
    let text: string;
    try {
      text = await readFile(this.oidcPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new HomectlError(5, "OIDC configuration cannot be read");
    }
    try {
      const parsed = JSON.parse(text) as OidcConfig;
      if (parsed.version !== 1) throw new Error("version");
      return validateOidcConfigInput(parsed);
    } catch {
      throw new HomectlError(
        5,
        "OIDC configuration is corrupt; run homectl control oidc clear and configure it again",
      );
    }
  }

  // Local operator: writes the configuration. No network access happens here;
  // keys are fetched on the first OIDC authentication.
  async configureOidc(input: Record<string, unknown>): Promise<{
    issuerHost: string;
    audience: string;
    jwks: "configured" | "discovery";
  }> {
    const config = validateOidcConfigInput(input);
    return this.store.withLock(async () => {
      const temp = `${this.oidcPath}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(config), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, this.oidcPath);
      await this.journal.append({
        event: "oidc.configured",
        client: SYSTEM_ACTOR,
        reason: `issuer=${issuerHost(config.issuer)}`,
      });
      return {
        issuerHost: issuerHost(config.issuer),
        audience: config.audience,
        jwks: config.jwksUrl ? "configured" : "discovery",
      };
    });
  }

  async clearOidc(): Promise<void> {
    await this.store.withLock(async () => {
      await rm(this.oidcPath, { force: true });
      await this.journal.append({
        event: "oidc.configured",
        client: SYSTEM_ACTOR,
        reason: "disabled",
      });
    });
  }

  // Read-only view for the CLI and the panel: no secrets, no subjects.
  async oidcView(): Promise<
    | {
        issuer: string;
        issuerHost: string;
        audience: string;
        jwks: "configured" | "discovery";
        jwksHost?: string;
        maxLifetimeSeconds: number;
        keyCount: number;
        refreshedAt?: string;
        lastError?: string;
        mappedClients: number;
      }
    | undefined
  > {
    const config = await this.loadOidc();
    if (!config) return undefined;
    const mapped = Object.values(await this.registry.load()).filter(
      (record) => record.oidc?.issuer === config.issuer,
    ).length;
    const status: JwksStatus = this.oidcSources
      .get(`${config.issuer}|${config.jwksUrl ?? ""}`)
      ?.status() ?? { keyCount: 0 };
    return {
      issuer: config.issuer,
      issuerHost: issuerHost(config.issuer),
      audience: config.audience,
      jwks: config.jwksUrl ? "configured" : "discovery",
      ...(config.jwksUrl ? { jwksHost: new URL(config.jwksUrl).host } : {}),
      maxLifetimeSeconds: config.maxLifetimeSeconds ?? MAX_LIFETIME_SECONDS,
      keyCount: status.keyCount,
      ...(status.refreshedAt !== undefined
        ? { refreshedAt: new Date(status.refreshedAt).toISOString() }
        : {}),
      ...(status.lastError ? { lastError: status.lastError } : {}),
      mappedClients: mapped,
    };
  }

  // One key cache per issuer and JWKS source, shared by every request.
  private oidcSource(config: OidcConfig): JwksSource {
    const key = `${config.issuer}|${config.jwksUrl ?? ""}`;
    let source = this.oidcSources.get(key);
    if (!source) {
      const fetcher: Fetcher =
        this.options.oidcFetch ?? ((url, init) => fetch(url, init));
      source = new JwksSource(config.issuer, config.jwksUrl, fetcher, () =>
        this.clock(),
      );
      this.oidcSources.set(key, source);
    }
    return source;
  }

  private async authenticateOidc(
    token: string,
  ): Promise<ClientIdentity | null> {
    const config = await this.loadOidc();
    if (!config) return null;
    const host = issuerHost(config.issuer);
    let verified: Awaited<ReturnType<typeof verifyOidcToken>>;
    try {
      verified = await verifyOidcToken(token, {
        config,
        source: this.oidcSource(config),
        nowMs: this.clock(),
      });
    } catch (error) {
      const code = error instanceof OidcRefusal ? error.code : "oidc-format";
      await this.auditRejection(
        `OIDC token refused: ${code}`,
        `oidc|${code}|${host}`,
      );
      return null;
    }
    // The IdP proves identity only: the homectl client record decides access.
    const clients = await this.registry.load();
    const matches = Object.values(clients).filter((record) => {
      if (!record.oidc || record.oidc.issuer !== verified.issuer) return false;
      const claim =
        record.oidc.claim === "sub" ? verified.subject : verified.clientId;
      return claim === record.oidc.value;
    });
    const record = matches.length === 1 ? matches[0] : undefined;
    if (!record) {
      await this.auditRejection(
        `OIDC token refused: oidc-unmapped`,
        `oidc|oidc-unmapped|${host}`,
      );
      return null;
    }
    if (record.revokedAt !== undefined) {
      await this.auditRejection(
        `OIDC token refused: oidc-revoked`,
        `oidc|oidc-revoked|${record.id}`,
      );
      return null;
    }
    // One audit entry per token, not per request: the cache forgets it at expiry.
    if (
      this.oidcAuditSeen.first(
        tokenIdentityKey(verified),
        verified.exp * 1000,
        this.clock(),
      )
    ) {
      await this.audit({
        event: "auth.oidc",
        client: record.id,
        reason: `issuer=${host}; subject-sha256=${identityHash(verified.subject)}`,
      });
    }
    return {
      id: record.id,
      name: record.name,
      scopes: [...record.scopes],
      hosts: [...record.hosts],
    };
  }

  // Validates an OIDC mapping for a new client against the configured issuer.
  private async oidcMappingFor(
    raw: unknown,
  ): Promise<
    { issuer: string; claim: "sub" | "client_id"; value: string } | undefined
  > {
    if (raw === undefined) return undefined;
    const config = await this.loadOidc();
    if (!config)
      throw new HomectlError(
        2,
        "Configure OIDC first: homectl control oidc set --issuer URL --audience AUD",
      );
    const input = raw as { claim?: unknown; value?: unknown };
    if (
      (input.claim !== "sub" && input.claim !== "client_id") ||
      typeof input.value !== "string" ||
      !printableText(input.value, 256)
    )
      throw new HomectlError(
        2,
        "OIDC mapping needs --oidc-subject or --oidc-client-id with a printable value",
      );
    return { issuer: config.issuer, claim: input.claim, value: input.value };
  }

  async recordAuthRejection(): Promise<void> {
    await this.auditRejection(
      "Missing or invalid client credential",
      "generic",
    );
  }

  // Identical rejections are written once per minute, with how many were suppressed.
  private async auditRejection(reason: string, key: string): Promise<void> {
    const decision = this.rejectionLimiter.check(key, this.clock());
    if (!decision.emit) return;
    await this.audit({
      event: "auth.rejected",
      client: SYSTEM_ACTOR,
      reason:
        decision.suppressed > 0
          ? `${reason}; ${decision.suppressed} identical suppressed`
          : reason,
    }).catch(() => undefined);
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
  ): Promise<{ client: ClientView; token?: string }> {
    const parsed = validateClientInput(input);
    const oidc = await this.oidcMappingFor(input.oidc);
    // A client has a static token, an OIDC mapping, or both. OIDC-only has one route.
    if (input.issueToken === false && oidc === undefined)
      throw new HomectlError(
        2,
        "A client needs a static token or an OIDC mapping",
      );
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
      if (
        oidc &&
        Object.values(clients).some(
          (other) =>
            other.oidc?.issuer === oidc.issuer &&
            other.oidc.claim === oidc.claim &&
            other.oidc.value === oidc.value,
        )
      )
        throw new HomectlError(
          2,
          "That OIDC identity is already mapped to a client",
        );
      const token = input.issueToken === false ? undefined : generateToken();
      const record: ClientRecord = {
        ...parsed,
        ...(token ? { tokenHash: tokenDigest(token).toString("hex") } : {}),
        createdAt: now,
        ...(oidc ? { oidc } : {}),
      };
      await this.journal.append({ event: "client.created", client: parsed.id });
      clients[parsed.id] = record;
      await this.registry.save(clients);
      return {
        client: clientView(record),
        ...(token ? { token } : {}),
      };
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
    return (await this.allViews(now, state))
      .filter((op) => wanted === undefined || wanted.includes(op.state))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  // Every operation this device knows about: held locally (annotated with the
  // replicated owner, delivery and takeover) or held only by another device.
  private async allViews(
    now: number,
    state: ControlState,
  ): Promise<OperationView[]> {
    const overlay = await this.overlayFor(state);
    const local = Object.values(state.operations).map((op) => {
      const view = operationView(op, now);
      const note = overlay.notes[op.id];
      return note ? { ...view, ...note } : view;
    });
    return [...local, ...overlay.remote];
  }

  private async overlayFor(state: ControlState): Promise<ReplicaOverlay> {
    if (!this.options.replicaOverlay) return { notes: {}, remote: [] };
    return this.options.replicaOverlay(new Set(Object.keys(state.operations)));
  }

  // Full id, or a unique prefix of at least 8 characters.
  async resolveOperation(idOrPrefix: string): Promise<string> {
    const state = await this.store.loadState();
    const ids = (await this.allViews(this.clock(), state)).map(
      (view) => view.operationId,
    );
    const lower = idOrPrefix.toLowerCase();
    if (ids.includes(lower)) return lower;
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

  async hasHost(host: string): Promise<boolean> {
    const inventory = await loadInventory(this.options.inventoryPath);
    return machineOf(inventory, host) !== undefined;
  }

  // Takeover: rebuild a replicated operation on this device. The plan is derived
  // from this device's own inventory, so the host must be enrolled here. The
  // operation starts pending and needs a fresh approval (its fingerprint may
  // differ from the old owner's).
  // A device that already holds an operation and takes it over again (A to B and
  // back to A) starts it pending. An approval given for an earlier owner never
  // carries over: the approval record is removed, so a fresh one is needed.
  async resetForOwnership(operationId: string): Promise<void> {
    await this.store.withLock(async () => {
      const now = this.clock();
      const state = await this.store.loadState();
      const op = Object.hasOwn(state.operations, operationId)
        ? state.operations[operationId]
        : undefined;
      if (!op) throw new HomectlError(2, "Unknown operation");
      if (op.state === "executing" || TERMINAL_STATES.includes(op.state))
        throw new HomectlError(
          3,
          "This operation already ran or is running; it cannot be taken over",
        );
      await this.journal.append({
        event: "operation.planned",
        client: SYSTEM_ACTOR,
        op: "plan",
        operationId,
        host: op.plan.host,
        fingerprint: op.fingerprint,
        classification: op.plan.classification,
        reason: "re-adopted-by-takeover",
      });
      op.state = "pending";
      op.updatedAt = now;
      delete op.approval;
      await this.store.saveState(state);
    });
  }

  async adoptOperation(input: {
    operationId: string;
    host: string;
    argv: string[];
    impact: string;
    issuer: string;
    catalogueInput?: CatalogueInput;
    fingerprint?: string;
  }): Promise<OperationView> {
    return this.store.withLock(async () => {
      const now = this.clock();
      const state = await this.store.loadState();
      if (Object.hasOwn(state.operations, input.operationId))
        throw new HomectlError(2, "Operation already exists on this device");
      const inventory = await loadInventory(this.options.inventoryPath);
      const machine = machineOf(inventory, input.host);
      if (!machine)
        throw new HomectlError(
          3,
          `Host ${input.host} is not in this device's inventory; takeover refused`,
        );
      const plan =
        input.catalogueInput === undefined
          ? buildPlan(input.host, machine, input.argv, input.impact)
          : catalogueAdoptionPlan(
              {
                host: input.host,
                catalogueInput: input.catalogueInput,
                fingerprint: input.fingerprint,
              },
              inventory,
              machine,
            );
      const record: OperationRecord = {
        apiVersion: CONTROL_API_VERSION,
        id: input.operationId,
        state: "pending",
        plan,
        fingerprint: fingerprint(plan),
        issuer: input.issuer,
        createdAt: now,
        expiresAt: now + PLAN_TTL_MS,
        updatedAt: now,
        spawnAttempted: false,
      };
      await this.journal.append({
        event: "operation.planned",
        client: SYSTEM_ACTOR,
        op: "plan",
        operationId: record.id,
        host: input.host,
        fingerprint: record.fingerprint,
        classification: plan.classification,
        reason: "adopted-by-takeover",
      });
      state.operations[record.id] = record;
      await this.store.saveState(state);
      return operationView(record, now);
    });
  }

  async showOperation(operationId: string): Promise<OperationView> {
    const state = await this.store.loadState();
    const view = (await this.allViews(this.clock(), state)).find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!view) throw new HomectlError(2, "No operation matches that id");
    return view;
  }

  verifyAudit() {
    return this.journal.verify();
  }

  // Replicated-control events from the replicator (identifiers and fixed reasons only).
  async auditEntries() {
    return this.journal.read();
  }

  async recordReplicated(event: AuditEvent): Promise<void> {
    await this.audit(event);
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
      case "proxmox-plan":
        return this.proxmoxPlan(client, req);
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
    const views = await this.allViews(now, state);
    if (operationId !== undefined) {
      const view = views.find((v) => v.operationId === operationId);
      if (!view || !permitsHost(client, view.host))
        throw new HomectlError(3, "Operation unavailable");
      return view;
    }
    return {
      client,
      operations: views
        .filter((v) => permitsHost(client, v.host))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 50),
    };
  }

  private async plan(client: ClientIdentity, req: PlanRequest) {
    requireScope(client, "plan:create");
    requireHost(client, req.host);
    return this.createPlan(
      client,
      req.host,
      req.argv,
      req.impact ?? "",
      req.idempotencyKey,
    );
  }

  // Proxmox guest plans: the argv comes only from the typed catalogue. The node
  // and VMID range come from the inventory provider for this host.
  private async proxmoxPlan(
    client: ClientIdentity,
    req: Extract<OperationRequest, { op: "proxmox-plan" }>,
  ) {
    requireScope(client, "plan:create");
    requireHost(client, req.host);
    const inventory = await loadInventory(this.options.inventoryPath);
    const machine = machineOf(inventory, req.host);
    if (!machine) throw new HomectlError(2, "Unknown host");
    if (machine.access !== "full")
      throw new HomectlError(
        3,
        "Proxmox guest actions need a full-access host",
      );
    const provider = Object.values(inventory.providers ?? {}).find(
      (candidate) => candidate.host === req.host,
    );
    if (!provider)
      throw new HomectlError(
        3,
        "This host is not a configured Proxmox provider",
      );
    const { op: _op, host: _host, ...input } = req;
    const built = buildProxmoxPlan(
      input as ProxmoxInput,
      providerFacts(provider),
    );
    const argv =
      machine.user === "root" ? built.argv : ["sudo", "-n", ...built.argv];
    return this.createPlan(
      client,
      req.host,
      argv,
      built.label,
      undefined,
      true,
      input as CatalogueInput,
    );
  }

  // Shared by generic and catalogue plans. Only the Proxmox catalogue sets catalogue.
  private async createPlan(
    client: ClientIdentity,
    host: string,
    argv: string[],
    impact: string,
    idempotencyKey?: string,
    catalogue = false,
    catalogueInput?: CatalogueInput,
  ) {
    if (containsSecretMaterial(`${argv.join("\n")}\n${impact}`))
      throw new HomectlError(
        2,
        "Secret-like material is not accepted in control-plane plans",
      );
    return this.mutate(async (state, now) => {
      const inventory = await loadInventory(this.options.inventoryPath);
      const machine = machineOf(inventory, host);
      if (!machine) throw new HomectlError(2, "Unknown host");
      const plan = buildPlan(host, machine, argv, impact, catalogue);
      if (catalogueInput !== undefined)
        plan.catalogueInput = structuredClone(catalogueInput);
      const planFingerprint = fingerprint(plan);
      const key =
        idempotencyKey === undefined
          ? undefined
          : `${client.id}:${idempotencyKey}`;
      const requestDigest = fingerprint({
        host: host,
        argv: argv,
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
        ...(idempotencyKey !== undefined
          ? { idempotencyKey: idempotencyKey }
          : {}),
      };
      await this.journal.append({
        event: "operation.planned",
        client: client.id,
        op: "plan",
        operationId: id,
        host: host,
        argv: redactArgv(argv),
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
      // A catalogue plan is judged by the facts in force now, not the stored argv.
      let argv = op.plan.argv;
      let impact = op.plan.impact;
      if (op.plan.catalogue === true) {
        const now = catalogueArgvNow(
          await loadInventory(this.options.inventoryPath),
          op.plan.host,
          machine,
          op.plan.catalogueInput,
        );
        if (!now) return "policy-refused";
        argv = now.argv;
        impact = now.label;
      }
      fresh = buildPlan(
        op.plan.host,
        machine,
        argv,
        impact,
        op.plan.catalogue === true,
      );
      if (op.plan.catalogueInput !== undefined)
        fresh.catalogueInput = op.plan.catalogueInput;
    } catch {
      return "policy-refused";
    }
    return fingerprint(fresh) === op.fingerprint ? "ok" : "machine-changed";
  }

  // Local possession only: replicated views of other devices' operations do not count.
  async holdsOperation(operationId: string): Promise<boolean> {
    const state = await this.store.loadState();
    return Object.hasOwn(state.operations, operationId);
  }

  private async approve(client: ClientIdentity, req: ApproveRequest) {
    requireScope(client, "approve:decide");
    // An operation this device does not hold is decided by its owner: the
    // replicator signs the decision and forwards it (ADR-0002 stage c).
    if (
      this.options.remoteDecision &&
      !(await this.holdsOperation(req.operationId))
    )
      return this.options.remoteDecision(client, req);
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
    // Approvers registered on another device are judged by the replicated
    // registration, which the owner gets through the approver-authority hook.
    if (!record) {
      const remote = this.options.approverAuthorized?.(approverId, host);
      // Never close an operation because the authority cannot be read here.
      if (remote === undefined)
        throw new HomectlError(
          5,
          "The approver is registered on another device and its replicated authority is not available here. Run this through a running homectl serve, or sync first. Nothing was changed.",
        );
      return remote;
    }
    if (record.revokedAt !== undefined) return false;
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
      if (!op) {
        const remote = (await this.allViews(now, state)).find(
          (view) => view.operationId === operationId && view.remote === true,
        );
        if (remote?.runsOn)
          throw new HomectlError(
            3,
            `Operation runs on ${remote.runsOn}; run homectl control execute there`,
          );
        throw new HomectlError(2, "Unknown operation");
      }
      // The replication fence comes first: an operation this device may not run
      // must say why, not that it needs approval.
      const refusal = await this.options.fence?.(op.id);
      if (refusal) throw new HomectlError(3, refusal);
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
      // The managed SSH config must name the inventory's current addresses before
      // anything is sent: a stale file would route the command to the old host.
      // Refusing here leaves the operation unchanged.
      await writeSSHConfig(
        this.options.configPath,
        (await loadInventory(this.options.inventoryPath)).machines,
      );
      // Consume the nonce and mark `executing` durably before any spawn.
      if (approval !== undefined) {
        approval.state = "consumed";
        approval.consumedAt = now;
        state.consumedNonces.push(approval.nonce);
      }
      op.state = "executing";
      op.updatedAt = now;
      op.executorPid = process.pid;
      op.executorInstance = PROCESS_INSTANCE;
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
        delete op.executorInstance;
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
        catalogue: op.plan.catalogue === true,
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
          catalogue: prepared.catalogue === true,
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
      delete op.executorInstance;
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
