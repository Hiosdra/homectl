// Local operator commands for the control plane. These run in the homectl
// host's own terminal; none of them is reachable through MCP.
import { stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { confirm } from "../cli/prompts";
import { loadInventory } from "../inventory";
import { writeSSHConfig } from "../operations";
import { localApi } from "../peer/local-api";
import { protect } from "../platform";
import { HomectlError, type Runner } from "../types";
import {
  ControlPlane,
  controlStateDirectory,
  type ExecuteResult,
} from "./engine";
import { DEFAULT_MCP_PORT, startMcpServer } from "./mcp";
import { parseLifetime } from "./oidc";
import {
  colorEnabled,
  mcpSnippet,
  paint,
  renderAudit,
  renderClients,
  renderExecution,
  renderOperationDetail,
  renderOperations,
  renderSync,
  type Style,
  type SyncView,
  shortId,
} from "./present";
import {
  createRecoveryKey,
  exportRecoveryBundle,
  restoreRecoveryBundle,
} from "./recovery";
import {
  deviceNames,
  fenceOf,
  loadReplicaFile,
  overlayOf,
  replicatedApproverAuthority,
  summarize,
} from "./replicator";
import { type McpControl, ServedControl } from "./served";
import { OPERATION_STATES, type OperationState, SCOPES } from "./types";

export interface ControlCliInput {
  inventoryPath: string;
  configPath: string;
  // Test seam: replaces process execution. The command line never sets it.
  runner?: Runner;
  positionals: string[];
  values: {
    port?: string;
    name?: string;
    scopes?: string;
    hosts?: string;
    "token-file"?: string;
    host?: string;
    state?: string;
    all?: boolean;
    to?: string;
    owner?: string;
    cancel?: boolean;
    reason?: string;
    issuer?: string;
    audience?: string;
    "jwks-url"?: string;
    "max-lifetime"?: string;
    "oidc-subject"?: string;
    "oidc-client-id"?: string;
    out?: string;
    key?: string;
    bundle?: string;
  };
  dryRun: boolean;
  json: boolean;
  color?: boolean;
}

// `value` is the JSON form; `human` is the text printed without --json.
export interface ControlCliResult {
  value: unknown;
  human: string;
  code: number;
}

// Loads the inventory first so a missing inventory fails like other commands,
// then opens the control plane (creating its private state directory).
async function openPlane(input: ControlCliInput): Promise<ControlPlane> {
  await loadInventory(input.inventoryPath);
  const stateDirectory = controlStateDirectory(input.inventoryPath);
  // Replicated authority for approvers registered on other devices, from the
  // saved replica. Without a saved replica, such approvers cannot be judged here.
  const replica = await loadReplicaFile(stateDirectory);
  const plane = new ControlPlane({
    inventoryPath: input.inventoryPath,
    configPath: input.configPath,
    stateDirectory,
    runner: input.runner,
    approverAuthorized: replica
      ? (approverId, host) =>
          replicatedApproverAuthority(replica, approverId, host)
      : undefined,
    // Without a running serve, the CLI reads the last saved replica. It applies
    // the same fence, so a paired owner whose lease has lapsed cannot run here.
    fence: async (operationId) => {
      const data = await loadReplicaFile(stateDirectory);
      if (!data) return undefined;
      return fenceOf(data, data.self?.id ?? "", operationId, Date.now());
    },
    replicaOverlay: async (localIds) => {
      const data = await loadReplicaFile(stateDirectory);
      if (!data?.self) return { notes: {}, remote: [] };
      const inventory = await loadInventory(input.inventoryPath);
      return overlayOf(data, data.self.id, localIds, Date.now(), async (host) =>
        Object.hasOwn(inventory.machines, host),
      );
    },
  });
  await plane.init();
  return plane;
}

// Calls the running serve through its local panel gate (launch token, cookie,
// loopback Host and Origin checks). Returns undefined when no serve answers.
async function liveRequest<T>(
  input: ControlCliInput,
  path: string,
  value?: unknown,
): Promise<T | undefined> {
  try {
    return await localApi<T>(input.inventoryPath, path, value);
  } catch (error) {
    // "No homectl workspace..." (no launch file) or a failed connection: no serve.
    if (!(error instanceof HomectlError)) return undefined;
    if (error.message.startsWith("No homectl workspace is open."))
      return undefined;
    throw error;
  }
}

function listOption(value: string | undefined, name: string): string[] {
  if (value === undefined) throw new HomectlError(2, `--${name} is required`);
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) throw new HomectlError(2, `--${name} is empty`);
  return items;
}

function useColor(input: ControlCliInput): boolean {
  return input.color ?? (!input.json && colorEnabled());
}

// No serve is running: execute from this process. The managed SSH config is
// refreshed first, in the same order as `homectl exec`.
async function executeHere(
  input: ControlCliInput,
  action: string,
): Promise<ExecuteResult> {
  const plane = await openPlane(input);
  const operationId = await plane.resolveOperation(action);
  await writeSSHConfig(
    input.configPath,
    (await loadInventory(input.inventoryPath)).machines,
  );
  return (await plane.request(
    { kind: "local-operator" },
    { op: "execute", operationId },
  )) as ExecuteResult;
}

// Starts the loopback MCP endpoint until interrupted. `onReady` prints the
// startup line (JSON or text) once the port is bound.
// The control plane serve-mcp uses. A running serve is the single writer: its
// local routes run every call. Without one, this process opens the plane.
export async function mcpControl(
  input: ControlCliInput,
): Promise<{ control: McpControl; served: boolean }> {
  const live = await liveRequest<unknown>(input, "/api/state");
  if (live !== undefined)
    return { control: new ServedControl(input.inventoryPath), served: true };
  return { control: await openPlane(input), served: false };
}

export async function serveMcp(
  input: ControlCliInput,
  onReady: (value: unknown, human: string) => void,
): Promise<void> {
  const bind = input.values.host ?? "127.0.0.1";
  const { control: plane } = await mcpControl(input);
  const port =
    input.values.port === undefined
      ? DEFAULT_MCP_PORT
      : Number(input.values.port);
  const running = startMcpServer({ control: plane, port, bind });
  const active = (await plane.listClients()).filter((c) => !c.revoked).length;
  const lan = bind !== "127.0.0.1";
  const value = {
    mcp: running.url,
    bind,
    transport: "http",
    activeClients: active,
    next: "Give each client its own token file. Press Ctrl+C to stop the endpoint.",
  };
  const color = useColor(input);
  onReady(
    value,
    [
      `${paint("MCP endpoint ready", "green", color)} at ${running.url}`,
      lan
        ? `Bound to ${bind} (LAN). Plain HTTP: bearer tokens are not encrypted on the network. Keep this to the trusted LAN, or put HTTPS in front before wider use.`
        : `Bound to ${bind} only.`,
      `Active clients: ${active}.`,
      "Give each client its own token file. Press Ctrl+C to stop.",
    ].join("\n"),
  );
  await new Promise<void>((done) => {
    const stop = () => {
      running.stop();
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function parseStates(value: string | undefined): OperationState[] | undefined {
  if (value === undefined) return undefined;
  const states = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = states.filter(
    (state) => !(OPERATION_STATES as readonly string[]).includes(state),
  );
  if (unknown.length > 0 || states.length === 0)
    throw new HomectlError(
      2,
      `Unknown state; valid states: ${OPERATION_STATES.join(", ")}`,
    );
  return states as OperationState[];
}

export async function controlCommand(
  input: ControlCliInput,
): Promise<ControlCliResult> {
  const [group, action, argument] = input.positionals;
  const color = useColor(input);
  const now = Date.now();
  if (group === "client") {
    if (action === "add") return addClient(input, argument);
    if (action === "list") {
      if (input.positionals.length !== 2)
        throw new HomectlError(2, "Usage: homectl control client list");
      const plane = await openPlane(input);
      const clients = await plane.listClients();
      return {
        value: { clients },
        human: renderClients(clients, { color }),
        code: 0,
      };
    }
    if (action === "revoke") {
      if (!argument || input.positionals.length !== 3)
        throw new HomectlError(2, "Usage: homectl control client revoke <id>");
      if (input.dryRun)
        return {
          value: { wouldRevoke: argument, credentialAccess: false },
          human: `Would revoke ${argument}. No change made.`,
          code: 0,
        };
      const plane = await openPlane(input);
      const current = (await plane.listClients()).find(
        (c) => c.id === argument,
      );
      if (
        current &&
        !current.revoked &&
        !input.json &&
        process.stdin.isTTY &&
        !(await confirm(
          `Revoke ${argument}? Its token stops working immediately.`,
        ))
      )
        return {
          value: { client: current, changed: false, cancelled: true },
          human: "Not revoked.",
          code: 0,
        };
      const { client, changed } = await plane.revokeClient(argument);
      return {
        value: { client, changed },
        human: changed
          ? `Client ${client.id} revoked. Its token stops working immediately.`
          : `Client ${client.id} was already revoked; nothing changed.`,
        code: 0,
      };
    }
  }
  if (group === "ops") {
    if (input.positionals.length !== 1)
      throw new HomectlError(
        2,
        "Usage: homectl control ops [--state LIST] [--all]",
      );
    const plane = await openPlane(input);
    const operations = await plane.listOperations({
      states: parseStates(input.values.state),
      all: input.values.all === true,
    });
    return {
      value: { operations },
      human: renderOperations(operations, { color, now }),
      code: 0,
    };
  }
  if (group === "show") {
    if (!action || input.positionals.length !== 2)
      throw new HomectlError(2, "Usage: homectl control show <operation-id>");
    const plane = await openPlane(input);
    const operationId = await plane.resolveOperation(action);
    const operation = await plane.showOperation(operationId);
    return {
      value: { operation },
      human: renderOperationDetail(operation, { color, now }),
      code: 0,
    };
  }
  if (group === "execute") {
    if (!action || input.positionals.length !== 2)
      throw new HomectlError(
        2,
        "Usage: homectl control execute <operation-id>",
      );
    if (input.dryRun)
      return {
        value: { wouldExecute: action, credentialAccess: false },
        human: `Would execute ${action}. No change made.`,
        code: 0,
      };
    // A running serve is the single writer and holds the replicated authority;
    // without one, this process executes with the saved replica's authority.
    const live = await liveRequest<ExecuteResult>(
      input,
      "/api/control/execute",
      {
        operationId: action,
      },
    );
    const result = live ?? (await executeHere(input, action));
    const state = result.operation.state;
    const code =
      state === "succeeded"
        ? 0
        : state === "unknown"
          ? 5
          : result.operation.exitCode !== undefined
            ? 6
            : 3;
    return {
      value: result,
      human: renderExecution(result, { color }),
      code,
    };
  }
  if (group === "sync") {
    if (input.positionals.length !== 1)
      throw new HomectlError(2, "Usage: homectl control sync");
    const live = await liveRequest<
      SyncView & { checkedAt?: string; running?: boolean }
    >(input, "/api/control/sync");
    const view: SyncView = live
      ? { ...live, live: live.running === true }
      : await savedSync(input.inventoryPath, now);
    return {
      value: view,
      human: renderSync(view, { color, now }),
      code: 0,
    };
  }
  if (group === "handoff") {
    if (!action || input.positionals.length !== 2)
      throw new HomectlError(
        2,
        "Usage: homectl control handoff <operation-id> --to DEVICE  (or --cancel to withdraw an offer)",
      );
    const to = input.values.to;
    const cancel = input.values.cancel === true;
    if (cancel && to !== undefined)
      throw new HomectlError(2, "Use either --to DEVICE or --cancel, not both");
    if (input.dryRun)
      return {
        value: cancel
          ? { wouldCancelOffer: action, credentialAccess: false }
          : {
              wouldHandoff: { operationId: action, to },
              credentialAccess: false,
            },
        human: cancel
          ? `Would withdraw the handoff offer for ${action}. No change made.`
          : `Would hand ${action} to ${to ?? "the device that takes over"}. No change made.`,
        code: 0,
      };
    const result = await liveRequest<{
      operationId: string;
      next: string;
    }>(input, "/api/control/handoff", {
      operationId: action,
      ...(to !== undefined ? { to } : {}),
      ...(cancel ? { cancel: true } : {}),
    });
    if (!result) throw new HomectlError(5, "Open homectl panel first");
    return {
      value: result,
      human: `${shortId(result.operationId)}: ${result.next}`,
      code: 0,
    };
  }
  if (group === "peer") {
    if (
      (action !== "suspend" && action !== "resume") ||
      !argument ||
      input.positionals.length !== 3
    )
      throw new HomectlError(
        2,
        "Usage: homectl control peer suspend DEVICE [--reason TEXT]  |  homectl control peer resume DEVICE",
      );
    const suspend = action === "suspend";
    if (input.dryRun)
      return {
        value: {
          wouldSetLease: { device: argument, suspended: suspend },
          credentialAccess: false,
        },
        human: `Would ${suspend ? "suspend" : "resume"} ${argument} in this device's lease. No change made.`,
        code: 0,
      };
    const result = await liveRequest<{ target: string; next?: string }>(
      input,
      "/api/control/peer",
      {
        target: argument,
        suspend,
        ...(input.values.reason !== undefined
          ? { reason: input.values.reason }
          : {}),
      },
    );
    if (!result) throw new HomectlError(5, "Open homectl panel first");
    return {
      value: result,
      human: suspend
        ? `Suspended ${argument} from this device's lease. ${result.next ?? ""}`
        : `Resumed ${argument}: it counts toward this device's lease again.`,
      code: 0,
    };
  }
  if (group === "resolve") {
    if (!action || input.positionals.length !== 2)
      throw new HomectlError(
        2,
        "Usage: homectl control resolve <operation-id> --owner DEVICE",
      );
    if (input.dryRun)
      return {
        value: {
          wouldResolve: action,
          owner: input.values.owner ?? null,
          credentialAccess: false,
        },
        human: `Would propose ${input.values.owner ?? "a winner"} for ${action}. No change made.`,
        code: 0,
      };
    const result = await liveRequest<{
      operationId: string;
      next: string;
    }>(input, "/api/control/resolve", {
      operationId: action,
      ...(input.values.owner !== undefined
        ? { owner: input.values.owner }
        : {}),
    });
    if (!result) throw new HomectlError(5, "Open homectl panel first");
    return {
      value: result,
      human: `${shortId(result.operationId)}: ${result.next}`,
      code: 0,
    };
  }
  if (group === "oidc") {
    if (action === "set" && input.positionals.length === 2) {
      if (!input.values.issuer || !input.values.audience)
        throw new HomectlError(
          2,
          "Usage: homectl control oidc set --issuer URL --audience AUD [--jwks-url URL]",
        );
      if (input.dryRun)
        return {
          value: {
            wouldConfigureOidc: { issuer: input.values.issuer },
            credentialAccess: false,
          },
          human: "Would configure OIDC for this device. No change made.",
          code: 0,
        };
      const plane = await openPlane(input);
      const view = await plane.configureOidc({
        issuer: input.values.issuer,
        audience: input.values.audience,
        ...(input.values["jwks-url"] !== undefined
          ? { jwksUrl: input.values["jwks-url"] }
          : {}),
        // A cap only: it can shorten the one-hour default, never extend it.
        ...(input.values["max-lifetime"] !== undefined
          ? { maxLifetimeSeconds: parseLifetime(input.values["max-lifetime"]) }
          : {}),
      });
      return {
        value: { configured: true, ...view },
        human: `OIDC configured: issuer ${view.issuerHost}, audience ${view.audience}. Keys are fetched on the first sign-in, from ${view.jwks === "configured" ? "the configured JWKS URL" : "the issuer's discovery document"}. Map a client with: control client add ... --oidc-subject SUB`,
        code: 0,
      };
    }
    if (action === "show" && input.positionals.length === 2) {
      const plane = await openPlane(input);
      const view = await plane.oidcView();
      const value = view
        ? {
            configured: true,
            issuerHost: view.issuerHost,
            audience: view.audience,
            jwks: view.jwks,
            ...(view.jwksHost ? { jwksHost: view.jwksHost } : {}),
            maxLifetimeSeconds: view.maxLifetimeSeconds,
            keyCount: view.keyCount,
            ...(view.refreshedAt ? { refreshedAt: view.refreshedAt } : {}),
            ...(view.lastError ? { lastError: view.lastError } : {}),
            mappedClients: view.mappedClients,
          }
        : { configured: false };
      return {
        value,
        human: view
          ? `OIDC: issuer ${view.issuerHost}, audience ${view.audience}, JWKS ${view.jwks}${view.jwksHost ? ` (${view.jwksHost})` : ""}, tokens up to ${Math.round(view.maxLifetimeSeconds / 60)} min, ${view.keyCount} key(s)${view.lastError ? `, last error ${view.lastError}` : ""}, ${view.mappedClients} mapped client(s). Static tokens keep working.`
          : "OIDC is not configured. Static client tokens are the only credentials.",
        code: 0,
      };
    }
    if (action === "clear" && input.positionals.length === 2) {
      const plane = await openPlane(input);
      await plane.clearOidc();
      return {
        value: { configured: false },
        human:
          "OIDC configuration removed. OIDC tokens are refused until it is configured again; static tokens are unaffected.",
        code: 0,
      };
    }
    throw new HomectlError(
      2,
      "Use control oidc set --issuer URL --audience AUD [--jwks-url URL], control oidc show or control oidc clear",
    );
  }
  if (group === "recovery") {
    const stateDirectory = controlStateDirectory(input.inventoryPath);
    if (action === "key" && input.positionals.length === 2) {
      if (!input.values.out)
        throw new HomectlError(
          2,
          "Usage: homectl control recovery key --out PATH",
        );
      const made = await createRecoveryKey(stateDirectory, input.values.out);
      return {
        value: made,
        human: `Recovery key written to ${made.path} (key id ${made.keyId}). Keep it outside every device. The key itself is not printed.`,
        code: 0,
      };
    }
    if (action === "export" && input.positionals.length === 2) {
      if (!input.values.key || !input.values.out)
        throw new HomectlError(
          2,
          "Usage: homectl control recovery export --key PATH --out PATH",
        );
      const bundle = await exportRecoveryBundle({
        stateDirectory,
        keyPath: input.values.key,
        outPath: input.values.out,
      });
      return {
        value: bundle,
        human: `Recovery bundle written to ${bundle.path} (key id ${bundle.keyId}). It holds: ${bundle.files.join(", ")}.`,
        code: 0,
      };
    }
    if (action === "restore" && input.positionals.length === 2) {
      if (!input.values.key || !input.values.bundle)
        throw new HomectlError(
          2,
          "Usage: homectl control recovery restore --key PATH --bundle PATH",
        );
      const restored = await restoreRecoveryBundle({
        stateDirectory,
        keyPath: input.values.key,
        bundlePath: input.values.bundle,
      });
      return {
        value: restored,
        human: `Restored ${restored.restored.length} control file(s) with key id ${restored.keyId}. Start serve again; this device keeps its previous identity.`,
        code: 0,
      };
    }
    throw new HomectlError(
      2,
      "Usage: homectl control recovery key --out PATH | export --key PATH --out PATH | restore --key PATH --bundle PATH",
    );
  }
  if (group === "audit" && action === "verify") {
    if (input.positionals.length !== 2)
      throw new HomectlError(2, "Usage: homectl control audit verify");
    const plane = await openPlane(input);
    const check = await plane.verifyAudit();
    if (!check.ok)
      throw new HomectlError(
        5,
        `Audit journal failed verification (${check.error ?? "unknown"}); preserve the file and investigate`,
      );
    return {
      value: {
        ok: true,
        entries: check.entries,
        head: check.head,
        anchored: check.anchored,
      },
      human: renderAudit(check, { color }),
      code: 0,
    };
  }
  throw new HomectlError(
    2,
    "Use control client add|list|revoke, control ops, control show <id>, control execute <id>, control handoff <id> --to DEVICE, control resolve <id> --owner DEVICE, control sync or control audit verify",
  );
}

// The last saved replica, for when no serve is running. Backoff is unknown
// because it lives only in the running scheduler.
async function savedSync(
  inventoryPath: string,
  now: number,
): Promise<SyncView> {
  const data = await loadReplicaFile(controlStateDirectory(inventoryPath));
  if (!data)
    return { live: false, peers: [], conflicts: [], blocked: {}, names: {} };
  const status = summarize(data, now);
  return {
    live: false,
    peers: status.peers.map((peer) => ({
      name: peer.name,
      lastSync: peer.lastSync,
      leaseOk: peer.leaseOk,
      refused: peer.refused,
      excluded: peer.excluded,
      suspended: peer.suspended,
    })),
    conflicts: status.conflicts,
    resolutions: status.resolutions.map((r) => ({
      opId: r.opId,
      conflictEpoch: r.conflictEpoch,
      winner: r.winner,
      resolver: r.resolver,
    })),
    names: deviceNames(data),
    blocked: status.blocked,
  };
}

async function addClient(
  input: ControlCliInput,
  id: string | undefined,
): Promise<ControlCliResult> {
  if (!id || input.positionals.length !== 3)
    throw new HomectlError(
      2,
      "Usage: homectl control client add <id> --name NAME --scopes LIST --hosts LIST [--token-file PATH] [--oidc-subject SUB | --oidc-client-id CID]",
    );
  const oidcSubject = input.values["oidc-subject"];
  const oidcClientId = input.values["oidc-client-id"];
  if (oidcSubject !== undefined && oidcClientId !== undefined)
    throw new HomectlError(
      2,
      "Use either --oidc-subject or --oidc-client-id, not both",
    );
  const oidc =
    oidcSubject !== undefined
      ? { claim: "sub", value: oidcSubject }
      : oidcClientId !== undefined
        ? { claim: "client_id", value: oidcClientId }
        : undefined;
  // A mapped client gets a static token only when --token-file asks for one:
  // without it the client is OIDC only, with a single route.
  const issueToken =
    oidc === undefined || input.values["token-file"] !== undefined;
  if (oidc === undefined && input.values["token-file"] === undefined)
    throw new HomectlError(
      2,
      "--token-file is required; the token is written there and never printed",
    );
  const request = {
    id,
    name: input.values.name ?? "",
    scopes: listOption(input.values.scopes, "scopes"),
    hosts: listOption(input.values.hosts, "hosts"),
    ...(oidc ? { oidc } : {}),
    issueToken,
  };
  const tokenFile = issueToken
    ? resolve(input.values["token-file"] as string)
    : undefined;
  if (input.dryRun)
    return {
      value: {
        wouldCreate: request,
        ...(tokenFile ? { tokenFile } : {}),
        credentialAccess: false,
      },
      human: tokenFile
        ? `Would create client ${id} with token file ${tokenFile}. No change made.`
        : `Would create OIDC-only client ${id}; no token is issued. No change made.`,
      code: 0,
    };
  const unknown = request.scopes.filter(
    (scope) => !(SCOPES as readonly string[]).includes(scope),
  );
  if (unknown.length > 0)
    throw new HomectlError(
      2,
      `Unknown scope; valid scopes: ${SCOPES.join(", ")}`,
    );
  if (tokenFile !== undefined) {
    // Check the destination first: a refused file must not leave a client behind.
    if (
      !(await stat(dirname(tokenFile)).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      throw new HomectlError(2, "Token file directory does not exist");
    if (
      await stat(tokenFile).then(
        () => true,
        () => false,
      )
    )
      throw new HomectlError(3, "Token file already exists; choose a new path");
  }
  const plane = await openPlane(input);
  const created = await plane.createClient(request);
  if (tokenFile !== undefined) {
    try {
      await writeFile(tokenFile, `${created.token}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await protect(tokenFile);
    } catch {
      await plane.revokeClient(id).catch(() => undefined);
      throw new HomectlError(
        3,
        "Token file could not be created privately (it must not already exist); client was revoked",
      );
    }
  }
  const color = useColor(input);
  if (tokenFile === undefined) {
    return {
      value: { client: created.client, auth: "oidc-only" },
      human: [
        `${paint("Created client", "green", color)} ${created.client.id} (${created.client.name}).`,
        "OIDC only: no static token was issued. Clients sign in with an OIDC access token whose subject maps to this client.",
        "To also issue a static token later, recreate the client with --token-file PATH.",
      ].join("\n"),
      code: 0,
    };
  }
  const snippet = mcpSnippet(`homectl-${id}`, "http://127.0.0.1:7449/mcp");
  const style: Style = "bold";
  return {
    value: {
      client: created.client,
      tokenFile,
      mcpSnippet: JSON.parse(snippet),
      note: "The token was saved to tokenFile and is never printed.",
    },
    human: [
      `${paint("Created client", "green", color)} ${created.client.id} (${created.client.name}).`,
      `Token saved to ${tokenFile} (owner-only). Point the MCP client at this file; it is never printed.`,
      "",
      paint("Next: add this to your MCP client configuration", style, color),
      "(replace the header value with the token read from the file):",
      "",
      snippet,
    ].join("\n"),
    code: 0,
  };
}
