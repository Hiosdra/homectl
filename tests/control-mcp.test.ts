import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import {
  type McpServer,
  RETIRED_MESSAGE,
  startMcpServer,
} from "../src/control/mcp";
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
    tokens[client.id] = created.token as string;
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

    content: { type: string; text: string }[];
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
    // The server may answer 413 and close before the upload finishes; a client
    // may then see a reset instead of the status. Either way nothing is processed.
    const response = await fetch(f.server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: huge,
    }).catch((error: unknown) => error);
    if (response instanceof Response) expect(response.status).toBe(413);
    else expect(response).toBeInstanceOf(Error);
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
      (older.json?.result as { protocolVersion?: string } | undefined)
        ?.protocolVersion,
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

  test("the retired endpoint advertises an empty catalogue", async () => {
    const f = await fixture();
    for (const token of Object.values(f.tokens)) {
      const response = await rpc(f, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(response.json?.result).toEqual({ tools: [] });
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

  test("the retired endpoint refuses calls without reaching the engine", async () => {
    const f = await fixture();
    for (const name of [
      "homectl_plan",
      "homectl_approve",
      "homectl_proxmox_plan",
      "homectl_exec",
    ]) {
      const result = await call(f, f.tokens["codex-pc"] ?? "", name, {});
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: RETIRED_MESSAGE }],
      });
    }
    expect(f.calls).toHaveLength(0);
    expect(await f.plane.listOperations({ all: true })).toEqual([]);
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

describe("explicit LAN bind", () => {
  function lanAddress(): string | undefined {
    for (const list of Object.values(networkInterfaces()))
      for (const entry of list ?? [])
        if (entry.family === "IPv4" && !entry.internal) return entry.address;
    return undefined;
  }

  test("wildcard, multicast, broadcast and non-IPv4 addresses are refused before binding", async () => {
    const f = await fixture();
    for (const bind of ["0.0.0.0", "224.0.0.1", "255.255.255.255", "::", "lan"])
      expect(() => startMcpServer({ control: f.plane, port: 0, bind })).toThrow(
        HomectlError,
      );
  });

  test("an explicit LAN address serves /mcp, names itself in metadata, and still needs a bearer token", async () => {
    const address = lanAddress();
    if (address === undefined) return; // no non-loopback interface on this host
    const f = await fixture();
    const lan = startMcpServer({ control: f.plane, port: 0, bind: address });
    try {
      expect(lan.url).toBe(`http://${address}:${lan.port}/mcp`);
      const metadata = await fetch(
        `http://${address}:${lan.port}/.well-known/oauth-protected-resource`,
      );
      expect(((await metadata.json()) as { resource: string }).resource).toBe(
        `http://${address}:${lan.port}/mcp`,
      );
      const anonymous = await fetch(lan.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(anonymous.status).toBe(401);
      const rebind = await fetch(lan.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "rebind.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(rebind.status).toBe(403);
    } finally {
      lan.stop();
    }
  });
});

describe("port conflicts", () => {
  test("a busy port is reported plainly, not as a generic failure", async () => {
    const f = await fixture();
    const busy = Number(new URL(f.server.url).port);
    let caught: unknown;
    try {
      startMcpServer({ control: f.plane, port: busy });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HomectlError);
    expect((caught as HomectlError).message).toBe(
      `Port ${busy} is already in use; stop the other process or choose another port with --port`,
    );
  });
});
