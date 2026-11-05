import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../src/serve";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function panel() {
  const root = await mkdtemp(join(tmpdir(), "homectl-panel-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const inventory = join(root, "inventory.yaml");
  await writeFile(
    inventory,
    `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`,
  );
  const running = await serve({
    inventoryPath: inventory,
    configPath: `${inventory}.ssh_config`,
    port: 0,
    peerPort: 0,
    discover: false,
  });
  cleanup.push(() => running.stop());
  const launch = JSON.parse(await readFile(running.launch, "utf8"));
  const connect = await fetch(`${running.url}/api/connect`, {
    method: "POST",
    headers: { Origin: running.url, "Content-Type": "application/json" },
    body: JSON.stringify({ token: launch.token }),
  });
  const cookie = connect.headers.get("set-cookie")?.split(";")[0] ?? "";
  const call = (
    method: string,
    path: string,
    body?: unknown,
    withCookie = true,
  ) =>
    fetch(`${running.url}${path}`, {
      method,
      headers: {
        Origin: running.url,
        ...(withCookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { running, call, cookie };
}

test("the panel control API requires the local session cookie", async () => {
  const { call } = await panel();
  expect((await call("GET", "/api/control", undefined, false)).status).toBe(
    403,
  );
  expect(
    (await call("POST", "/api/control/audit/verify", {}, false)).status,
  ).toBe(403);
});

test("the panel shows the queue, executes approved or inspection work, and never approves", async () => {
  const { running, call } = await panel();
  const control = running.control;
  const created = await control.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "status:read"],
    hosts: ["agent-host"],
  });
  const identity = await control.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  const plan = (await control.request(
    { kind: "client", client: identity },
    { op: "plan", host: "agent-host", argv: ["hostname"] },
  )) as { operationId: string };

  const overview = await call("GET", "/api/control");
  expect(overview.status).toBe(200);
  const body = (await overview.json()) as {
    operations: {
      operationId: string;
      state: string;
      needsApproval: boolean;
    }[];
    clients: { id: string; revoked: boolean }[];
    audit: { ok: boolean; entries: number };
  };
  expect(body.operations.map((o) => o.operationId)).toContain(plan.operationId);
  expect(body.clients.map((c) => c.id)).toEqual(["codex-pc"]);
  expect(body.audit.ok).toBe(true);
  expect(body.audit.entries).toBeGreaterThan(0);

  // The panel has no approval route: a client decision cannot come from it.
  const approve = await call("POST", "/api/control/approve", {
    operationId: plan.operationId,
  });
  expect(approve.status).toBe(404);

  const ran = await call("POST", "/api/control/execute", {
    operationId: plan.operationId,
  });
  expect(ran.status).toBe(200);
  const result = (await ran.json()) as {
    operation: { state: string; exitCode: number };
    output: { stdout: string };
  };
  expect(result.operation.state).toBe("succeeded");
  expect(result.operation.exitCode).toBe(0);

  const again = await call("POST", "/api/control/execute", {
    operationId: plan.operationId,
  });
  expect(again.status).toBe(403);
});

test("the panel revokes clients idempotently and reports unknown operations plainly", async () => {
  const { running, call } = await panel();
  await running.control.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["status:read"],
    hosts: ["agent-host"],
  });
  const first = (await (
    await call("POST", "/api/control/revoke", { id: "codex-pc" })
  ).json()) as {
    changed: boolean;
  };
  expect(first.changed).toBe(true);
  const second = (await (
    await call("POST", "/api/control/revoke", { id: "codex-pc" })
  ).json()) as {
    changed: boolean;
  };
  expect(second.changed).toBe(false);
  const missing = await call("POST", "/api/control/execute", {
    operationId: "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
  });
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: string }).error).toBe(
    "Unknown operation",
  );
});
