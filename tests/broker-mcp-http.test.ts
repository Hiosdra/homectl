// MCP over HTTP inside the daemon (POST /mcp) must pass the same checks as the
// /v1 routes: the client token is required, owner tokens are refused, ungranted
// hosts are refused, risky commands wait for the owner, and a revoked client is
// refused on its next call. Everything runs through the real daemon transport.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { FileVerifier } from "../src/broker/owner";
import type { Endpoint } from "../src/broker/paths";
import { compatPaths } from "../src/broker/paths";

let dir: string;
let stop: (() => Promise<void>) | undefined;
const PASSWORD = "owner password for tests";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-mcp-http-"));
  await writeFile(
    join(dir, "inventory.yaml"),
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n  nas:\n    description: not granted to the test client\n    transport: local\n    access: user\n",
  );
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function boot() {
  const inventoryPath = join(dir, "inventory.yaml");
  const ran: string[][] = [];
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    executor: {
      run: async ({ argv }) => {
        ran.push(argv);
        return { exitCode: 0, stdout: "fine", stderr: "" };
      },
    },
  });
  stop = daemon.stop;
  // Keep real password verification and use smaller test-only Argon2 settings.
  await new FileVerifier(join(compatPaths(inventoryPath).state, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  }).set(PASSWORD);
  const endpoint = daemon.endpoint;
  const { token: owner } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint },
  );
  const asOwner = { endpoint, authorization: `Owner ${owner}` };
  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex-pc", name: "Codex", hosts: ["pc"], password: PASSWORD },
    asOwner,
  );
  return { endpoint, owner, agent: created.token, ran, asOwner };
}

// POST one JSON-RPC message to /mcp, optionally with an Authorization header.
async function mcp(endpoint: Endpoint, body: unknown, authorization?: string) {
  const unix = endpoint.transport === "unix";
  const response = await fetch(
    unix ? "http://localhost/mcp" : `${endpoint.address}/mcp`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
      ...(unix ? { unix: endpoint.address } : {}),
    } as RequestInit,
  );
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
  };
}

let nextId = 1;
type ToolResult = {
  isError: boolean;
  content: { text: string }[];
};

async function tool(
  endpoint: Endpoint,
  agent: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const response = await mcp(
    endpoint,
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    },
    `Bearer ${agent}`,
  );
  return response.json?.result as ToolResult;
}

// Tool text is a short notice (for untrusted output) followed by JSON.
function dataOf(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? "";
  const json = text.slice(text.indexOf("{"));
  return JSON.parse(json) as Record<string, unknown>;
}

test("MCP over HTTP is refused without a client token and never takes an owner token", async () => {
  const { endpoint, owner } = await boot();
  const anonymous = await mcp(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  });
  expect(anonymous.status).toBe(401);
  const asOwner = await mcp(
    endpoint,
    { jsonrpc: "2.0", id: 1, method: "ping" },
    `Owner ${owner}`,
  );
  expect(asOwner.status).toBe(401);
  const garbage = await mcp(
    endpoint,
    { jsonrpc: "2.0", id: 1, method: "ping" },
    "Bearer not-a-token",
  );
  expect(garbage.status).toBe(401);
});

test("tools/list offers the catalogue with closed schemas, and notifications get 202", async () => {
  const { endpoint, agent } = await boot();
  const listed = await mcp(
    endpoint,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    `Bearer ${agent}`,
  );
  const result = listed.json?.result as
    | {
        tools: {
          name: string;
          inputSchema: { additionalProperties: boolean };
        }[];
      }
    | undefined;
  const tools = result?.tools ?? [];
  expect(tools.length).toBeGreaterThan(0);
  expect(tools.map((t) => t.name)).toEqual([
    "hosts",
    "exec",
    "proxmox",
    "status",
    "list",
    "wait",
    "verify",
    "cancel",
    "task_open",
    "task_close",
    "secret_request",
    "secret_status",
    "secret_cancel",
    "secret_use",
  ]);
  expect(tools.every((t) => t.inputSchema.additionalProperties === false)).toBe(
    true,
  );
  const notification = await mcp(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    `Bearer ${agent}`,
  );
  expect(notification.status).toBe(202);
});

test("the MCP route uses the engine: granted hosts run, ungranted hosts are refused", async () => {
  const { endpoint, agent, ran } = await boot();
  expect(dataOf(await tool(endpoint, agent, "hosts", {}))).toMatchObject({
    id: "codex-pc",
    hosts: ["pc"],
  });
  const safe = dataOf(
    await tool(endpoint, agent, "exec", {
      host: "pc",
      argv: ["hostname"],
      waitMs: 5000,
    }),
  );
  expect(safe.state).toBe("succeeded");
  expect(ran).toEqual([["hostname"]]);

  const refused = await tool(endpoint, agent, "exec", {
    host: "nas",
    argv: ["hostname"],
  });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]?.text).toContain("not in this client's grants");
  expect(ran.length).toBe(1);

  const secret = await tool(endpoint, agent, "secret_request", {
    purpose: "test",
    destination: { kind: "ssh-stdin", host: "nas", argv: ["tee", "/x"] },
    fields: [{ name: "token" }],
  });
  expect(secret.isError).toBe(true);
  expect(secret.content[0]?.text).toContain("Host not granted");
});

test("a risky command waits for the owner over MCP, then runs once", async () => {
  const { endpoint, agent, asOwner, ran } = await boot();
  const risky = dataOf(
    await tool(endpoint, agent, "exec", {
      host: "pc",
      argv: ["systemctl", "--user", "restart", "x"],
    }),
  );
  expect(risky.state).toBe("awaiting-approval");
  // Nothing has run yet, and the agent's own token cannot decide.
  expect(ran.length).toBe(0);
  await expect(
    callBroker(
      "/v1/owner/decide",
      {
        operationId: risky.id,
        fingerprint: risky.fingerprint,
        decision: "approve-once",
        password: PASSWORD,
      },
      { endpoint, authorization: `Bearer ${agent}` },
    ),
  ).rejects.toThrow();
  await callBroker(
    "/v1/owner/decide",
    {
      operationId: risky.id,
      fingerprint: risky.fingerprint,
      decision: "approve-once",
      password: PASSWORD,
    },
    asOwner,
  );
  const done = dataOf(
    await tool(endpoint, agent, "wait", { id: risky.id, timeoutMs: 5000 }),
  );
  expect(done.state).toBe("succeeded");
  expect(ran.length).toBe(1);
});

test("invalid arguments are a tool error, and a revoked client is refused", async () => {
  const { endpoint, agent, asOwner } = await boot();
  const invalid = await tool(endpoint, agent, "exec", { argv: ["hostname"] });
  expect(invalid.isError).toBe(true);
  expect(invalid.content[0]?.text).toContain("Invalid arguments for exec");
  const extra = await tool(endpoint, agent, "exec", {
    host: "pc",
    argv: ["hostname"],
    shell: "sh -c",
  });
  expect(extra.isError).toBe(true);

  await callBroker("/v1/owner/clients/revoke", { id: "codex-pc" }, asOwner);
  const after = await mcp(
    endpoint,
    { jsonrpc: "2.0", id: 1, method: "ping" },
    `Bearer ${agent}`,
  );
  expect(after.status).toBe(401);
});

test("verify over MCP records the agent's own check once and leaves the state alone", async () => {
  const { endpoint, agent } = await boot();
  const run = dataOf(
    await tool(endpoint, agent, "exec", {
      host: "pc",
      argv: ["hostname"],
      waitMs: 5000,
    }),
  );
  expect(run.state).toBe("succeeded");

  // The verdict is closed: anything but passed, failed or inconclusive is refused.
  const bad = await tool(endpoint, agent, "verify", {
    id: run.id,
    status: "ok",
    summary: "looks fine",
  });
  expect(bad.isError).toBe(true);
  expect(bad.content[0]?.text).toContain("Invalid arguments for verify");
  const noSummary = await tool(endpoint, agent, "verify", {
    id: run.id,
    status: "passed",
  });
  expect(noSummary.isError).toBe(true);

  const report = {
    id: run.id,
    status: "failed",
    summary: "hostname answers, but the wrong name",
  };
  const recorded = dataOf(await tool(endpoint, agent, "verify", report));
  expect(recorded).toMatchObject({
    id: run.id,
    state: "succeeded",
    result: { exitCode: 0 },
    verification: { status: "failed", summary: report.summary },
  });
  expect(
    dataOf(await tool(endpoint, agent, "status", { id: run.id })),
  ).toMatchObject({ state: "succeeded", verification: { status: "failed" } });

  const again = await tool(endpoint, agent, "verify", {
    ...report,
    status: "passed",
  });
  expect(again.isError).toBe(true);
  expect(again.content[0]?.text).toContain("already verified");
});
