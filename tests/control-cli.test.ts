import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import { cleanEnv } from "../src/credentials";
import { windows } from "../src/platform";

const cli = join(import.meta.dir, "../src/cli/main.ts");
const INVENTORY = `version: 1
machines:
  lab-printer:
    description: Test printer host
    transport: local
    access: user
  big:
    description: Test full-access host
    transport: local
    access: full
`;
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-control-cli-"));
  cleanup.push(dir);
  const inventory = join(dir, "inventory.yaml");
  await writeFile(inventory, INVENTORY);
  const tokens = join(dir, "tokens");
  await mkdir(tokens);
  return { dir, inventory, tokens };
}

async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    code: await child.exited,
  };
}

test("serve-mcp --dry-run reports the loopback bind without starting anything", async () => {
  const r = await invoke(["serve-mcp", "--dry-run", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({
    wouldServe: "mcp",
    bind: "127.0.0.1",
    credentialAccess: false,
  });
});

test("serve-mcp rejects unexpected arguments", async () => {
  expect((await invoke(["serve-mcp", "extra"])).code).toBe(2);
});

test("control-only options are refused on every other command", async () => {
  const f = await fixture();
  const r = await invoke([
    "hosts",
    "--name",
    "x",
    "--inventory",
    f.inventory,
    "--json",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("apply only to control");
  const plain = await invoke(["hosts", "--inventory", f.inventory, "--json"]);
  expect(plain.code).toBe(0);
});

test("client add writes the token to a new private file and never prints it", async () => {
  const f = await fixture();
  const tokenFile = join(f.tokens, "codex.token");
  const r = await invoke([
    "control",
    "client",
    "add",
    "codex-pc",
    "--name",
    "Codex PC",
    "--scopes",
    "status:read,inspect:read,plan:create",
    "--hosts",
    "lab-printer",
    "--token-file",
    tokenFile,
    "--inventory",
    f.inventory,
    "--json",
  ]);
  expect(r.code).toBe(0);
  expect(r.stdout).not.toContain("hct_");
  expect(r.stderr).not.toContain("hct_");
  const token = (await readFile(tokenFile, "utf8")).trim();
  expect(token).toMatch(/^hct_[A-Za-z0-9_-]{43}$/);
  if (!windows) expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  const listed = await invoke([
    "control",
    "client",
    "list",
    "--inventory",
    f.inventory,
    "--json",
  ]);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("codex-pc");
  expect(listed.stdout).not.toContain(token);
  expect(listed.stdout).not.toContain("tokenHash");
});

test("client add refuses an existing token file before creating a client", async () => {
  const f = await fixture();
  const tokenFile = join(f.dir, "existing.token");
  await writeFile(tokenFile, "keep me");
  const r = await invoke([
    "control",
    "client",
    "add",
    "codex-pc",
    "--name",
    "Codex PC",
    "--scopes",
    "status:read",
    "--hosts",
    "lab-printer",
    "--token-file",
    tokenFile,
    "--inventory",
    f.inventory,
  ]);
  expect(r.code).toBe(3);
  expect(await readFile(tokenFile, "utf8")).toBe("keep me");
  const listed = await invoke([
    "control",
    "client",
    "list",
    "--inventory",
    f.inventory,
    "--json",
  ]);
  expect(listed.stdout).not.toContain("codex-pc");
});

test("client add validates scopes, grants and required flags", async () => {
  const f = await fixture();
  const base = [
    "control",
    "client",
    "add",
    "codex-pc",
    "--inventory",
    f.inventory,
  ];
  expect(
    (
      await invoke([
        ...base,
        "--name",
        "x",
        "--scopes",
        "status:read",
        "--hosts",
        "lab-printer",
      ])
    ).code,
  ).toBe(2);
  expect(
    (
      await invoke([
        ...base,
        "--name",
        "x",
        "--scopes",
        "exec:run",
        "--hosts",
        "lab-printer",
        "--token-file",
        join(f.dir, "a.token"),
      ])
    ).code,
  ).toBe(2);
  expect(
    (
      await invoke([
        ...base,
        "--name",
        "x",
        "--scopes",
        "status:read",
        "--token-file",
        join(f.dir, "b.token"),
      ])
    ).code,
  ).toBe(2);
  const missingDirectory = await invoke([
    ...base,
    "--name",
    "x",
    "--scopes",
    "status:read",
    "--hosts",
    "lab-printer",
    "--token-file",
    join(f.dir, "missing", "c.token"),
  ]);
  expect(missingDirectory.code).toBe(2);
  expect(missingDirectory.stderr).toContain("directory does not exist");
});

test("client revoke disables a client and reports it revoked", async () => {
  const f = await fixture();
  await invoke([
    "control",
    "client",
    "add",
    "codex-pc",
    "--name",
    "Codex PC",
    "--scopes",
    "status:read",
    "--hosts",
    "lab-printer",
    "--token-file",
    join(f.dir, "c.token"),
    "--inventory",
    f.inventory,
  ]);
  const r = await invoke([
    "control",
    "client",
    "revoke",
    "codex-pc",
    "--inventory",
    f.inventory,
    "--json",
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).client.revoked).toBe(true);
  expect(
    (
      await invoke([
        "control",
        "client",
        "revoke",
        "nobody",
        "--inventory",
        f.inventory,
      ])
    ).code,
  ).toBe(2);
});

test("execute refuses unknown operations and unknown subcommands", async () => {
  const f = await fixture();
  const unknown = await invoke([
    "control",
    "execute",
    "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
    "--inventory",
    f.inventory,
  ]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("No operation matches that id");
  expect(
    (await invoke(["control", "frobnicate", "--inventory", f.inventory])).code,
  ).toBe(2);
});

test("audit verify reports an empty, intact journal", async () => {
  const f = await fixture();
  const r = await invoke([
    "control",
    "audit",
    "verify",
    "--inventory",
    f.inventory,
    "--json",
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({
    ok: true,
    entries: 0,
    head: "0".repeat(64),
    anchored: false,
  });
});

test("control commands fail like other commands when the inventory is missing", async () => {
  const r = await invoke([
    "control",
    "client",
    "list",
    "--inventory",
    "/nonexistent-homectl-control-test/inventory.yaml",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Cannot read inventory");
});

test("serve-mcp answers an authenticated initialize over loopback and stops on signal", async () => {
  const f = await fixture();
  const tokenFile = join(f.dir, "server.token");
  const add = await invoke([
    "control",
    "client",
    "add",
    "codex-pc",
    "--name",
    "Codex PC",
    "--scopes",
    "status:read",
    "--hosts",
    "lab-printer",
    "--token-file",
    tokenFile,
    "--inventory",
    f.inventory,
  ]);
  expect(add.code).toBe(0);
  const token = (await readFile(tokenFile, "utf8")).trim();

  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "serve-mcp",
      "--port",
      "0",
      "--inventory",
      f.inventory,
      "--json",
    ],
    { env: cleanEnv(), stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  const info = JSON.parse(text.split("\n")[0] ?? "{}") as {
    mcp: string;
    bind: string;
  };
  expect(info.bind).toBe("127.0.0.1");
  expect(info.mcp).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  try {
    const response = await fetch(info.mcp, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { serverInfo: { name: "homectl" } },
    });
    const anonymous = await fetch(info.mcp, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
  } finally {
    child.kill();
    await child.exited;
    await reader.cancel().catch(() => undefined);
  }
});

test("client add rejects host names that are not in the inventory", async () => {
  const f = await fixture();
  const tokenFile = join(f.dir, "typo.token");
  const r = await invoke([
    "control",
    "client",
    "add",
    "codex-pc",
    "--name",
    "Codex PC",
    "--scopes",
    "status:read",
    "--hosts",
    "nope",
    "--token-file",
    tokenFile,
    "--inventory",
    f.inventory,
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Valid hosts: big, lab-printer");
  await expect(stat(tokenFile)).rejects.toBeDefined();
});

test("serve-mcp refuses non-loopback binding with a plain explanation", async () => {
  const f = await fixture();
  const r = await invoke([
    "serve-mcp",
    "--host",
    "0.0.0.0",
    "--port",
    "0",
    "--inventory",
    f.inventory,
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("binds only to loopback (127.0.0.1)");
  expect(r.stderr).not.toContain("details suppressed");
  const misplaced = await invoke([
    "hosts",
    "--host",
    "x",
    "--inventory",
    f.inventory,
  ]);
  expect(misplaced.code).toBe(2);
});

test("client list is an aligned table with revoked clients last and no bullets", async () => {
  const f = await fixture();
  const add = (id: string, hosts: string) =>
    invoke([
      "control",
      "client",
      "add",
      id,
      "--name",
      `${id} name`,
      "--scopes",
      "status:read,inspect:read",
      "--hosts",
      hosts,
      "--token-file",
      join(f.dir, `${id}.token`),
      "--inventory",
      f.inventory,
    ]);
  const created = await add("codex-pc", "lab-printer");
  expect(created.code).toBe(0);
  expect(created.stdout).toContain("Token saved to");
  expect(created.stdout).toContain("mcpServers");
  expect(created.stdout).toContain("http://127.0.0.1:7449/mcp");
  expect(created.stdout).not.toMatch(/hct_[A-Za-z0-9_-]{20,}/);
  await add("hermes-admin", "lab-printer,big");
  await invoke([
    "control",
    "client",
    "revoke",
    "codex-pc",
    "--inventory",
    f.inventory,
  ]);
  const listed = await invoke([
    "control",
    "client",
    "list",
    "--inventory",
    f.inventory,
  ]);
  const lines = listed.stdout.trimEnd().split("\n");
  expect(lines[0]).toMatch(
    /^ID\s+NAME\s+SCOPES\s+HOSTS\s+AUTH\s+CREATED\s+STATUS$/,
  );
  expect(lines[1]).toContain("hermes-admin");
  expect(lines[2]).toContain("codex-pc");
  expect(lines[2]).toContain("revoked");
  expect(listed.stdout).not.toContain("•");
  expect(listed.stdout).not.toContain(String.fromCharCode(27));
});

test("revoking an already revoked client is idempotent and says so", async () => {
  const f = await fixture();
  await invoke([
    "control",
    "client",
    "add",
    "codex-pc",
    "--name",
    "Codex PC",
    "--scopes",
    "status:read",
    "--hosts",
    "lab-printer",
    "--token-file",
    join(f.dir, "r.token"),
    "--inventory",
    f.inventory,
  ]);
  const first = await invoke([
    "control",
    "client",
    "revoke",
    "codex-pc",
    "--inventory",
    f.inventory,
  ]);
  expect(first.stdout).toContain("Client codex-pc revoked.");
  const second = await invoke([
    "control",
    "client",
    "revoke",
    "codex-pc",
    "--inventory",
    f.inventory,
  ]);
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("already revoked; nothing changed");
});

test("ops, show and execute accept short ids and print readable summaries", async () => {
  const f = await fixture();
  const plane = new ControlPlane({
    inventoryPath: f.inventory,
    configPath: join(f.dir, "ssh_config"),
    stateDirectory: join(f.dir, "control-plane"),
  });
  await plane.init();
  const created = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "status:read"],
    hosts: ["lab-printer"],
  });
  const identity = await plane.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  const plan = (await plane.request(
    { kind: "client", client: identity },
    { op: "plan", host: "lab-printer", argv: ["hostname"] },
  )) as { operationId: string };
  const short = plan.operationId.slice(0, 8);

  const ops = await invoke(["control", "ops", "--inventory", f.inventory]);
  expect(ops.code).toBe(0);
  expect(ops.stdout).toContain("ID");
  expect(ops.stdout).toContain(short);
  expect(ops.stdout).toContain("hostname");

  const shown = await invoke([
    "control",
    "show",
    short,
    "--inventory",
    f.inventory,
  ]);
  expect(shown.stdout).toContain(plan.operationId);
  expect(shown.stdout).toContain("Approver");

  const tooShort = await invoke([
    "control",
    "show",
    short.slice(0, 4),
    "--inventory",
    f.inventory,
  ]);
  expect(tooShort.code).toBe(2);

  const ran = await invoke([
    "control",
    "execute",
    short,
    "--inventory",
    f.inventory,
  ]);
  expect(ran.code).toBe(0);
  expect(ran.stdout).toContain(
    "✓ succeeded on lab-printer (exit 0) · no approval needed",
  );
  expect(ran.stdout).toContain(`$ hostname`);

  const again = await invoke([
    "control",
    "execute",
    short,
    "--inventory",
    f.inventory,
  ]);
  expect(again.code).toBe(3);
  expect(again.stderr).toContain("never retried");
});

test("show on a finished operation reports when it ran and how long, without plan expiry", async () => {
  const f = await fixture();
  const plane = new ControlPlane({
    inventoryPath: f.inventory,
    configPath: join(f.dir, "ssh_config"),
    stateDirectory: join(f.dir, "control-plane"),
  });
  await plane.init();
  const created = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "status:read"],
    hosts: ["lab-printer"],
  });
  const identity = await plane.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  const plan = (await plane.request(
    { kind: "client", client: identity },
    {
      op: "plan",
      host: "lab-printer",
      argv: ["whoami"],
      impact: "Read the account",
    },
  )) as { operationId: string };
  await invoke([
    "control",
    "execute",
    plan.operationId.slice(0, 8),
    "--inventory",
    f.inventory,
  ]);
  const shown = await invoke([
    "control",
    "show",
    plan.operationId.slice(0, 8),
    "--inventory",
    f.inventory,
  ]);
  expect(shown.stdout).toMatch(
    /^Executed\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/m,
  );
  expect(shown.stdout).toMatch(/^Duration\s+/m);
  expect(shown.stdout).toMatch(/^Exit code\s+0$/m);
  expect(shown.stdout).not.toContain("expires in");
  expect(shown.stdout).not.toMatch(/^(Plan|Approval)\s/m);
  expect(shown.stdout).toMatch(/^State\s+succeeded$/m);
  expect(shown.stdout).toContain("Approver");
});
