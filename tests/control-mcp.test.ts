import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import { type McpServer, startMcpServer, TOOLS } from "../src/control/mcp";
import { schemas } from "../src/control/schema";
import { HomectlError, type ProcessSpec } from "../src/types";

const INVENTORY = `version: 1
machines:
  lab-printer:
    description: Test printer host
    transport: local
    access: user
  nas:
    description: Test NAS host
    transport: local
    access: user
  big:
    description: Test full-access host
    transport: local
    access: full
`;
const CODEX = {
  id: "codex-pc",
  name: "Codex PC",
  scopes: ["status:read", "inspect:read", "plan:create"],
  hosts: ["lab-printer"],
};
const HERMES = {
  id: "hermes-admin",
  name: "Hermes Admin",
  scopes: ["status:read", "inspect:read", "approve:decide"],
  hosts: ["lab-printer"],
};

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Fixture = {
  dir: string;
  plane: ControlPlane;
  server: McpServer;
  calls: ProcessSpec[];
  tokens: Record<string, string>;
};

async function fixture(
  clients: (typeof CODEX)[] = [CODEX, HERMES],
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-mcp-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const calls: ProcessSpec[] = [];
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory: join(dir, "control-plane"),
    runner: async (spec) => {
      calls.push(spec);
      return { exitCode: 0, stdout: "Linux\n", stderr: "" };
    },
  });
  await plane.init();
  const tokens: Record<string, string> = {};
  for (const client of clients) {
    const created = await plane.createClient(client);
    tokens[client.id] = created.token;
  }
  const server = startMcpServer({ control: plane, port: 0 });
  cleanup.push(() => server.stop());
  return { dir, plane, server, calls, tokens };
}

let nextId = 1;
async function rpc(
  f: Fixture,
  token: string | undefined,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(f.server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
  };
}

async function call(
  f: Fixture,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await rpc(f, token, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return response.json?.result as {
    isError: boolean;
    structuredContent?: Record<string, unknown>;
    content: { text: string }[];
  };
}

describe("transport and authentication", () => {
  test("binds to loopback and advertises only /mcp", async () => {
    const f = await fixture();
    expect(f.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const other = await fetch(f.server.url.replace("/mcp", "/other"), {
      method: "POST",
      headers: { Authorization: `Bearer ${f.tokens["codex-pc"]}` },
    });
    expect(other.status).toBe(404);
  });

  test("requests without a valid bearer token are refused and audited without the token", async () => {
    const f = await fixture();
    const missing = await rpc(f, undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    const wrong = await rpc(f, `hct_${"B".repeat(43)}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(wrong.status).toBe(401);
    const malformed = await rpc(f, "garbage", {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    expect(malformed.status).toBe(401);
    expect(wrong.text).not.toContain("B".repeat(10));
    const audit = await readFile(
      join(f.dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"auth.rejected"');
    expect(audit).not.toContain(f.tokens["codex-pc"] ?? "");
  });

  test("a revoked client is refused on its next request", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    expect(
      (await rpc(f, token, { jsonrpc: "2.0", id: 1, method: "ping" })).status,
    ).toBe(200);
    await f.plane.revokeClient("codex-pc");
    expect(
      (await rpc(f, token, { jsonrpc: "2.0", id: 2, method: "ping" })).status,
    ).toBe(401);
  });

  test("GET and non-JSON requests are refused", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    const get = await fetch(f.server.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const text = await fetch(f.server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: "{}",
    });
    expect(text.status).toBe(400);
  });

  test("a non-loopback Host header is refused (DNS rebinding)", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    const response = await rpc(
      f,
      token,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { Host: "rebind.example" },
    );
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(token);
  });

  test("cross-origin browser requests are refused", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    const response = await rpc(
      f,
      token,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        Origin: "https://attacker.example",
      },
    );
    expect(response.status).toBe(403);
  });

  test("malformed JSON, batches and invalid envelopes get JSON-RPC errors", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    expect((await rpc(f, token, "{not json")).json).toMatchObject({
      error: { code: -32700 },
    });
    expect(
      (await rpc(f, token, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status,
    ).toBe(400);
    expect((await rpc(f, token, { id: 1, method: "ping" })).json).toMatchObject(
      { error: { code: -32600 } },
    );
    expect(
      (await rpc(f, token, { jsonrpc: "2.0", id: 1, method: "nope" })).json,
    ).toMatchObject({ error: { code: -32601 } });
  });

  test("oversized bodies are refused before parsing", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    const huge = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { padding: "x".repeat(300 * 1024) },
    });
    const response = await fetch(f.server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: huge,
    });
    expect(response.status).toBe(413);
  });

  test("notifications receive 202 with no body", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    const response = await rpc(f, token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(response.text).toBe("");
  });
});

describe("MCP methods", () => {
  test("initialize negotiates a supported protocol version and advertises tools only", async () => {
    const f = await fixture();
    const token = f.tokens["codex-pc"] ?? "";
    const older = await rpc(f, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    expect(
      (older.json?.result as { protocolVersion: string }).protocolVersion,
    ).toBe("2025-03-26");
    const unknown = await rpc(f, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const result = unknown.json?.result as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(Object.keys(result.capabilities)).toEqual(["tools"]);
    expect(result.serverInfo.name).toBe("homectl");
  });

  test("tools/list is filtered by scope and exposes no execution or shell tool", async () => {
    const f = await fixture();
    const codex = await rpc(f, f.tokens["codex-pc"], {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const hermes = await rpc(f, f.tokens["hermes-admin"], {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = (r: typeof codex) =>
      (r.json?.result as { tools: { name: string }[] }).tools
        .map((t) => t.name)
        .sort();
    expect(names(codex)).toEqual([
      "homectl_inspect",
      "homectl_plan",
      "homectl_status",
    ]);
    expect(names(hermes)).toEqual([
      "homectl_approve",
      "homectl_inspect",
      "homectl_status",
    ]);
    const everything = [...TOOLS.map((t) => t.name)].join(" ");
    expect(everything).not.toMatch(/exec|shell|execute|client|secret|sudo/i);
  });

  test("tool input schemas are self-contained and reject unknown properties", async () => {
    const f = await fixture();
    const response = await rpc(f, f.tokens["codex-pc"], {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (
      response.json?.result as {
        tools: { name: string; inputSchema: Record<string, unknown> }[];
      }
    ).tools;
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  test("ping answers with an empty result", async () => {
    const f = await fixture();
    const response = await rpc(f, f.tokens["codex-pc"], {
      jsonrpc: "2.0",
      id: "abc",
      method: "ping",
    });
    expect(response.json).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
  });

  test("unknown tools are a protocol error, not a tool result", async () => {
    const f = await fixture();
    const response = await rpc(f, f.tokens["codex-pc"], {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "homectl_exec", arguments: { argv: ["sh"] } },
    });
    expect(response.json).toMatchObject({ error: { code: -32602 } });
    expect(f.calls).toHaveLength(0);
  });
});

describe("tool calls through the engine", () => {
  test("plan then approve over JSON-RPC, with status reflecting each step", async () => {
    const f = await fixture();
    const codex = f.tokens["codex-pc"] ?? "";
    const hermes = f.tokens["hermes-admin"] ?? "";
    const plan = await call(f, codex, "homectl_plan", {
      host: "lab-printer",
      argv: ["uname", "-s"],
      impact: "read kernel name",
    });
    expect(plan.isError).toBe(false);
    expect(schemas.operationView(plan.structuredContent)).toBe(true);
    const operationId = plan.structuredContent?.operationId as string;
    const fingerprint = plan.structuredContent?.fingerprint as string;

    const approved = await call(f, hermes, "homectl_approve", {
      operationId,
      fingerprint,
      decision: "approve",
    });
    expect(approved.isError).toBe(false);
    expect(JSON.stringify(approved.structuredContent)).not.toContain("nonce");
    expect(schemas.approvalView(approved.structuredContent?.approval)).toBe(
      true,
    );

    const status = await call(f, codex, "homectl_status", { operationId });
    expect(status.structuredContent?.state).toBe("approved");
    expect(f.calls).toHaveLength(0);
  });

  test("a client cannot approve its own plan", async () => {
    const f = await fixture([
      { ...CODEX, scopes: [...CODEX.scopes, "approve:decide"] },
    ]);
    const codex = f.tokens["codex-pc"] ?? "";
    const plan = await call(f, codex, "homectl_plan", {
      host: "lab-printer",
      argv: ["uname"],
    });
    const self = await call(f, codex, "homectl_approve", {
      operationId: plan.structuredContent?.operationId,
      fingerprint: plan.structuredContent?.fingerprint,
      decision: "approve",
    });
    expect(self.isError).toBe(true);
    expect(self.content[0]?.text).toContain("Self-approval");
  });

  test("a client without plan:create cannot plan, and the refusal is audited", async () => {
    const f = await fixture();
    const denied = await call(
      f,
      f.tokens["hermes-admin"] ?? "",
      "homectl_plan",
      {
        host: "lab-printer",
        argv: ["uname"],
      },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("(code 3)");
    const audit = await readFile(
      join(f.dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"request.rejected"');
  });

  test("the typed op cannot be overridden by tool arguments", async () => {
    const f = await fixture();
    const codex = f.tokens["codex-pc"] ?? "";
    const plan = await call(f, codex, "homectl_plan", {
      host: "lab-printer",
      argv: ["uname"],
      op: "execute",
    });
    expect(plan.isError).toBe(false);
    const smuggled = await call(f, codex, "homectl_plan", {
      host: "lab-printer",
      argv: ["uname"],
      operationId: plan.structuredContent?.operationId,
    });
    expect(smuggled.isError).toBe(true);
    expect(smuggled.content[0]?.text).toContain(
      "Invalid control-plane request",
    );
    expect(f.calls).toHaveLength(0);
  });

  test("shells, full-access hosts and secrets are refused through tools", async () => {
    const f = await fixture([{ ...CODEX, hosts: ["lab-printer", "big"] }]);
    const codex = f.tokens["codex-pc"] ?? "";
    const shell = await call(f, codex, "homectl_plan", {
      host: "lab-printer",
      argv: ["sh", "-c", "id"],
    });
    expect(shell.isError).toBe(true);
    const full = await call(f, codex, "homectl_plan", {
      host: "big",
      argv: ["uname"],
    });
    expect(full.content[0]?.text).toContain("Full-access");
    const secret = await call(f, codex, "homectl_plan", {
      host: "lab-printer",
      argv: ["tool", "--token=abc123456"],
    });
    expect(secret.content[0]?.text).toContain("Secret-like");
    expect(f.calls).toHaveLength(0);
  });

  test("inspect returns redacted machine metadata and no execution", async () => {
    const f = await fixture();
    const result = await call(
      f,
      f.tokens["codex-pc"] ?? "",
      "homectl_inspect",
      { host: "lab-printer" },
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      host: "lab-printer",
      access: "user",
    });
    // Key names only: "user" is also a legitimate access value.
    expect(JSON.stringify(result.structuredContent)).not.toMatch(
      /"(address|auth|ssh_alias|user|port|sudo_allow|public_key|socket)":/,
    );
    const all = await call(
      f,
      f.tokens["codex-pc"] ?? "",
      "homectl_inspect",
      {},
    );
    expect((all.structuredContent?.hosts as unknown[]).length).toBe(1);
    expect(f.calls).toHaveLength(0);
  });

  test("ungranted and unknown hosts are indistinguishable through inspect", async () => {
    const f = await fixture();
    const codex = f.tokens["codex-pc"] ?? "";
    const ungranted = await call(f, codex, "homectl_inspect", { host: "nas" });
    const unknown = await call(f, codex, "homectl_inspect", { host: "ghost" });
    expect(ungranted.content[0]?.text).toBe(unknown.content[0]?.text);
  });

  test("status of an operation outside the caller's grants is unavailable", async () => {
    const f = await fixture([
      CODEX,
      HERMES,
      { ...HERMES, id: "other-admin", hosts: ["nas"] },
    ]);
    const plan = await call(f, f.tokens["codex-pc"] ?? "", "homectl_plan", {
      host: "lab-printer",
      argv: ["uname"],
    });
    const other = await call(
      f,
      f.tokens["other-admin"] ?? "",
      "homectl_status",
      {
        operationId: plan.structuredContent?.operationId,
      },
    );
    expect(other.isError).toBe(true);
    expect(other.content[0]?.text).toContain("Operation unavailable");
  });
});

describe("server lifecycle", () => {
  test("invalid ports are refused before binding", () => {
    const control = new ControlPlane({
      inventoryPath: "/nonexistent-homectl-test/inventory.yaml",
      configPath: "/nonexistent-homectl-test/ssh_config",
      stateDirectory: "/nonexistent-homectl-test/control-plane",
    });
    expect(() => startMcpServer({ control, port: 70000 })).toThrow(
      HomectlError,
    );
    expect(() => startMcpServer({ control, port: -1 })).toThrow(HomectlError);
  });
});
