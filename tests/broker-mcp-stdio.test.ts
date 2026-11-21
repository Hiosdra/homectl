// `home-ctl mcp` as a real child process, talking newline-delimited JSON-RPC on
// stdin/stdout, against a running daemon. stdout must carry protocol messages
// only, and without a broker or a token the tools explain what to run.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";

const MAIN = join(import.meta.dir, "..", "src", "cli", "main.ts");
let dir: string;
let stop: (() => Promise<void>) | undefined;
const PASSWORD = "owner password for tests";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-mcp-stdio-"));
  await writeFile(
    join(dir, "inventory.yaml"),
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n",
  );
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  await rm(dir, { recursive: true, force: true });
});

// Runs `home-ctl mcp` with the given stdin lines and returns its stdout lines.
async function runMcp(lines: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, MAIN, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: dir, USERPROFILE: dir, ...env },
  });
  for (const line of lines) proc.stdin.write(`${line}\n`);
  await proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    code,
    stderr,
    lines: stdout.split("\n").filter((line) => line.length > 0),
  };
}

type Reply = { id: unknown; result?: unknown; error?: unknown };
function replyTo(lines: string[]): Map<unknown, Reply> {
  const byId = new Map<unknown, Reply>();
  for (const line of lines) {
    const reply = JSON.parse(line) as Reply;
    byId.set(reply.id, reply);
  }
  return byId;
}

test("stdio: protocol over newline-delimited JSON, with the agent's own token", async () => {
  const inventoryPath = join(dir, "inventory.yaml");
  const paths = compatPaths(inventoryPath);
  const daemon = await startDaemon({
    mode: "compat",
    ...paths,
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    executor: {
      run: async () => ({ exitCode: 0, stdout: "fine", stderr: "" }),
    },
  });
  stop = daemon.stop;
  // Keep real password verification and use smaller test-only Argon2 settings.
  await new FileVerifier(join(paths.state, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  }).set(PASSWORD);
  const { token: owner } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint: daemon.endpoint },
  );
  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex-pc", name: "Codex", hosts: ["pc"], password: PASSWORD },
    { endpoint: daemon.endpoint, authorization: `Owner ${owner}` },
  );

  const risky = JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "exec",
      arguments: { host: "pc", argv: ["systemctl", "--user", "restart", "x"] },
    },
  });
  const run = await runMcp(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "hosts", arguments: {} },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "exec",
          arguments: { host: "pc", argv: ["hostname"], waitMs: 5000 },
        },
      }),
      risky,
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "approve_everything", arguments: {} },
      }),
      "{not json",
    ],
    {
      HOMECTL_BROKER_ENDPOINT: paths.endpoint,
      HOMECTL_TOKEN: created.token,
    },
  );
  expect(run.code).toBe(0);
  // Every stdout line is a JSON-RPC message; nothing else reaches stdout.
  for (const line of run.lines) expect(() => JSON.parse(line)).not.toThrow();
  const byId = replyTo(run.lines);

  expect(byId.get(1)?.result).toMatchObject({
    serverInfo: { name: "homectl" },
    protocolVersion: "2025-06-18",
  });
  const listed = byId.get(2)?.result as { tools: { name: string }[] };
  expect(listed.tools.map((t) => t.name)).toContain("secret_use");
  expect(byId.get(6)?.result).toEqual({});
  expect(byId.get(7)?.error).toMatchObject({ code: -32602 });
  expect(byId.get(null)?.error).toMatchObject({ code: -32700 });

  const hosts = byId.get(3)?.result as {
    content: { text: string }[];
    isError: boolean;
  };
  expect(hosts.isError).toBe(false);
  expect(hosts.content[0]?.text).toContain('"hosts": [');
  expect(hosts.content[0]?.text).toContain("pc");

  const safe = byId.get(4)?.result as { content: { text: string }[] };
  expect(safe.content[0]?.text).toContain('"state": "succeeded"');
  const waiting = byId.get(5)?.result as { content: { text: string }[] };
  expect(waiting.content[0]?.text).toContain('"state": "awaiting-approval"');
});

test("stdio: without a running broker, tools explain how to start it", async () => {
  const run = await runMcp(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hosts", arguments: {} },
      }),
    ],
    {
      HOMECTL_BROKER_ENDPOINT: join(dir, "missing-endpoint.json"),
      HOMECTL_TOKEN: "hct_unused",
    },
  );
  const reply = replyTo(run.lines).get(1)?.result as {
    isError: boolean;
    content: { text: string }[];
  };
  expect(reply.isError).toBe(true);
  expect(reply.content[0]?.text).toContain("home-ctl start");
});

test("stdio: without a client token, tools explain how the owner connects the agent", async () => {
  const inventoryPath = join(dir, "inventory.yaml");
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
  });
  stop = daemon.stop;
  const run = await runMcp(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hosts", arguments: {} },
      }),
    ],
    {
      HOMECTL_BROKER_ENDPOINT: compatPaths(inventoryPath).endpoint,
      HOMECTL_TOKEN: "",
    },
  );
  const reply = replyTo(run.lines).get(1)?.result as {
    isError: boolean;
    content: { text: string }[];
  };
  expect(reply.isError).toBe(true);
  expect(reply.content[0]?.text).toContain("home-ctl agent connect");
});
