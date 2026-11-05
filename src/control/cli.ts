// Local operator commands for the control plane. These run in the homectl
// host's own terminal; none of them is reachable through MCP.
import { stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { confirm } from "../cli/prompts";
import { loadInventory } from "../inventory";
import { writeSSHConfig } from "../operations";
import { protect } from "../platform";
import { HomectlError } from "../types";
import { ControlPlane, type ExecuteResult } from "./engine";
import { DEFAULT_MCP_PORT, startMcpServer } from "./mcp";
import {
  colorEnabled,
  mcpSnippet,
  paint,
  renderAudit,
  renderClients,
  renderExecution,
  renderOperationDetail,
  renderOperations,
  type Style,
} from "./present";
import { OPERATION_STATES, type OperationState, SCOPES } from "./types";

export interface ControlCliInput {
  inventoryPath: string;
  configPath: string;
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

export function controlStateDirectory(inventoryPath: string): string {
  return join(dirname(resolve(inventoryPath)), "control-plane");
}

// Loads the inventory first so a missing inventory fails like other commands,
// then opens the control plane (creating its private state directory).
async function openPlane(input: ControlCliInput): Promise<ControlPlane> {
  await loadInventory(input.inventoryPath);
  const plane = new ControlPlane({
    inventoryPath: input.inventoryPath,
    configPath: input.configPath,
    stateDirectory: controlStateDirectory(input.inventoryPath),
  });
  await plane.init();
  return plane;
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

// Starts the loopback MCP endpoint until interrupted. `onReady` prints the
// startup line (JSON or text) once the port is bound.
export async function serveMcp(
  input: ControlCliInput,
  onReady: (value: unknown, human: string) => void,
): Promise<void> {
  if (input.values.host !== undefined && input.values.host !== "127.0.0.1")
    throw new HomectlError(
      2,
      "serve-mcp binds only to loopback (127.0.0.1); use a reverse proxy or tunnel for remote clients.",
    );
  const plane = await openPlane(input);
  const port =
    input.values.port === undefined
      ? DEFAULT_MCP_PORT
      : Number(input.values.port);
  const running = startMcpServer({ control: plane, port });
  const active = (await plane.listClients()).filter((c) => !c.revoked).length;
  const value = {
    mcp: running.url,
    bind: "127.0.0.1",
    activeClients: active,
    next: "Give each client its own token file. Press Ctrl+C to stop the endpoint.",
  };
  const color = useColor(input);
  onReady(
    value,
    [
      `${paint("MCP endpoint ready", "green", color)} at ${running.url}`,
      `Bound to 127.0.0.1 only. Active clients: ${active}.`,
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
    const plane = await openPlane(input);
    const operationId = await plane.resolveOperation(action);
    // Same order as `homectl exec`: refresh the managed SSH config first.
    await writeSSHConfig(
      input.configPath,
      (await loadInventory(input.inventoryPath)).machines,
    );
    const result = (await plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId },
    )) as ExecuteResult;
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
    "Use control client add|list|revoke, control ops, control show <id>, control execute <id> or control audit verify",
  );
}

async function addClient(
  input: ControlCliInput,
  id: string | undefined,
): Promise<ControlCliResult> {
  if (!id || input.positionals.length !== 3)
    throw new HomectlError(
      2,
      "Usage: homectl control client add <id> --name NAME --scopes LIST --hosts LIST --token-file PATH",
    );
  if (!input.values["token-file"])
    throw new HomectlError(
      2,
      "--token-file is required; the token is written there and never printed",
    );
  const request = {
    id,
    name: input.values.name ?? "",
    scopes: listOption(input.values.scopes, "scopes"),
    hosts: listOption(input.values.hosts, "hosts"),
  };
  const tokenFile = resolve(input.values["token-file"]);
  if (input.dryRun)
    return {
      value: { wouldCreate: request, tokenFile, credentialAccess: false },
      human: `Would create client ${id} with token file ${tokenFile}. No change made.`,
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
  const plane = await openPlane(input);
  const created = await plane.createClient(request);
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
  const snippet = mcpSnippet(`homectl-${id}`, "http://127.0.0.1:7449/mcp");
  const color = useColor(input);
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
