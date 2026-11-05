// Local operator commands for the control plane. These run in the homectl
// host's own terminal; none of them is reachable through MCP.
import { stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadInventory } from "../inventory";
import { writeSSHConfig } from "../operations";
import { protect } from "../platform";
import { HomectlError } from "../types";
import { ControlPlane } from "./engine";
import { DEFAULT_MCP_PORT, startMcpServer } from "./mcp";
import { SCOPES } from "./types";

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
  };
  dryRun: boolean;
}

export interface ControlCliResult {
  value: unknown;
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

// Starts the loopback MCP endpoint until interrupted. Returns after stop.
export async function serveMcp(
  input: ControlCliInput,
  onReady: (value: unknown) => void,
): Promise<void> {
  const plane = await openPlane(input);
  const port =
    input.values.port === undefined
      ? DEFAULT_MCP_PORT
      : Number(input.values.port);
  const running = startMcpServer({ control: plane, port });
  const clients = (await plane.listClients()).filter((c) => !c.revoked).length;
  onReady({
    mcp: running.url,
    bind: "127.0.0.1",
    activeClients: clients,
    next: "Give each client its own token file. Press Ctrl+C to stop the endpoint.",
  });
  await new Promise<void>((done) => {
    const stop = () => {
      running.stop();
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function controlCommand(
  input: ControlCliInput,
): Promise<ControlCliResult> {
  const [group, action, argument] = input.positionals;
  if (group === "client") {
    if (action === "add") return addClient(input, argument);
    if (action === "list") {
      if (input.positionals.length !== 2)
        throw new HomectlError(2, "Usage: homectl control client list");
      const plane = await openPlane(input);
      return { value: { clients: await plane.listClients() }, code: 0 };
    }
    if (action === "revoke") {
      if (!argument || input.positionals.length !== 3)
        throw new HomectlError(2, "Usage: homectl control client revoke <id>");
      if (input.dryRun)
        return {
          value: { wouldRevoke: argument, credentialAccess: false },
          code: 0,
        };
      const plane = await openPlane(input);
      return { value: { client: await plane.revokeClient(argument) }, code: 0 };
    }
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
        code: 0,
      };
    const plane = await openPlane(input);
    // Same order as `homectl exec`: refresh the managed SSH config first.
    await writeSSHConfig(
      input.configPath,
      (await loadInventory(input.inventoryPath)).machines,
    );
    const result = (await plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: action },
    )) as { operation: { state: string; exitCode?: number } };
    const state = result.operation.state;
    const code =
      state === "succeeded"
        ? 0
        : state === "unknown"
          ? 5
          : result.operation.exitCode !== undefined
            ? 6
            : 3;
    return { value: result, code };
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
      value: { ok: true, entries: check.entries, head: check.head },
      code: 0,
    };
  }
  throw new HomectlError(
    2,
    "Use control client add|list|revoke, control execute <operation-id> or control audit verify",
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
  return {
    value: {
      client: created.client,
      tokenFile,
      note: "The token was written to tokenFile and is not printed. Configure the MCP client to read it from that file.",
    },
    code: 0,
  };
}
