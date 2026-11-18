import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_NORMALIZATION_MARKERS } from "../src/control/redact";
import { serve } from "../src/serve";
import { waitFor } from "./audit-test-helpers";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function panel(
  options: {
    access?: string;
    session?: boolean;
    operationRunner?: Parameters<typeof serve>[0]["operationRunner"];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "homectl-panel-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const inventory = join(root, "inventory.yaml");
  const configPath = `${inventory}.ssh_config`;
  const session = options.session
    ? `session:
  ttl: 24h
  database: ${JSON.stringify(join(root, "vault.kdbx"))}
`
    : "";
  await writeFile(
    inventory,
    `version: 1
${session}
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: ${options.access ?? "user"}
`,
  );
  const running = await serve({
    inventoryPath: inventory,
    configPath,
    port: 0,
    peerPort: 0,
    discover: false,
    operationRunner: options.operationRunner,
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
  return { running, call, cookie, configPath };
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

test("saved command API keeps unknown hosts unavailable and enforces policy with local redacted audit", async () => {
  let runs = 0;
  const { call } = await panel({
    access: "full",
    operationRunner: async () => {
      runs++;
      return {
        exitCode: 0,
        stdout: "OUTPUT_SHOULD_NOT_BE_IN_AUDIT",
        stderr: "",
      };
    },
  });
  const saved = await call("POST", "/api/commands/save", {
    command: {
      name: "Echo parameter",
      hosts: ["agent-host"],
      argv: ["echo", "--token", "{{token}}"],
      parameters: [{ name: "token", description: "Value for this run" }],
    },
  });
  expect(saved.status).toBe(200);
  const savedBody = (await saved.json()) as { command: { id: string } };
  const list = await call("GET", "/api/commands");
  const listed = (await list.json()) as {
    commands: { id: string; available: string[] }[];
  };
  expect(
    listed.commands.find((item) => item.id === savedBody.command.id)?.available,
  ).toEqual(["agent-host"]);

  await call("POST", "/api/commands/save", {
    command: { name: "Unavailable", hosts: ["unknown"], argv: ["hostname"] },
  });
  const unavailable = (await call("GET", "/api/commands").then((r) =>
    r.json(),
  )) as {
    commands: { name: string; available: string[]; unavailable: string[] }[];
  };
  expect(
    unavailable.commands.find((item) => item.name === "Unavailable"),
  ).toMatchObject({ available: [], unavailable: ["unknown"] });
  const blocked = await call("POST", "/api/commands/run", {
    id: savedBody.command.id,
    host: "unknown",
    parameters: { token: "unused" },
    dryRun: true,
  });
  expect(blocked.status).toBe(403);
  expect(((await blocked.json()) as { error: string }).error).toContain(
    "unavailable",
  );

  const values = { token: "hct_abcdefghijklmnop1234" };
  const previewResponse = await call("POST", "/api/commands/run", {
    id: savedBody.command.id,
    host: "agent-host",
    parameters: values,
    dryRun: true,
  });
  const preview = (await previewResponse.json()) as {
    plan: {
      approval: string;
      needsApproval: boolean;
      argv: string[];
      impact: string;
    };
  };
  expect(preview.plan.needsApproval).toBe(true);
  expect(preview.plan.argv).toEqual(["echo", "--token", "[REDACTED]"]);
  expect(JSON.stringify(preview)).not.toContain(values.token);
  const noApproval = await call("POST", "/api/commands/run", {
    id: savedBody.command.id,
    host: "agent-host",
    parameters: values,
    dryRun: false,
  });
  expect(noApproval.status).toBe(409);
  const approvalError = await noApproval.json();
  expect(JSON.stringify(approvalError)).not.toContain(values.token);
  expect((approvalError as { error: string }).error).toContain(
    "Request approval and Accept in the panel",
  );
  expect(runs).toBe(0);
  const executed = await call("POST", "/api/commands/run", {
    id: savedBody.command.id,
    host: "agent-host",
    parameters: values,
    dryRun: false,
    approval: preview.plan.approval,
  });
  expect(executed.status).toBe(200);
  const execution = await executed.json();
  expect(JSON.stringify(execution)).not.toContain(values.token);
  expect((execution as { plan: { argv: string[] } }).plan.argv).toEqual([
    "echo",
    "--token",
    "[REDACTED]",
  ]);
  expect(runs).toBe(1);

  const history = await waitFor(
    async () => {
      const response = await call(
        "GET",
        "/api/audit?host=agent-host&status=succeeded",
      );
      return (await response.json()) as {
        entries: { argv: string[]; status: string }[];
      };
    },
    (value) => value.entries.length > 0,
    "panel command audit entry",
  );
  expect(history.entries[0]?.argv).toEqual(["echo", "--token", "[REDACTED]"]);
  const serialized = JSON.stringify(history);
  expect(serialized).not.toContain(values.token);
  expect(serialized).not.toContain("OUTPUT_SHOULD_NOT_BE_IN_AUDIT");

  const removed = await call("POST", "/api/commands/remove", {
    id: savedBody.command.id,
  });
  expect(removed.status).toBe(200);
}, 30_000);

test("API refuses every audit normalization marker and does not rewrite SSH config before approval", async () => {
  const { call, configPath } = await panel();
  await writeFile(configPath, "preserve this file");
  const markers = [
    AUDIT_NORMALIZATION_MARKERS.emptyArgument,
    AUDIT_NORMALIZATION_MARKERS.truncatedArgument,
    `${AUDIT_NORMALIZATION_MARKERS.truncatedArgumentsPrefix}2${AUDIT_NORMALIZATION_MARKERS.truncatedArgumentsSuffix}`,
    AUDIT_NORMALIZATION_MARKERS.noArguments,
    AUDIT_NORMALIZATION_MARKERS.redacted,
  ];
  for (const [index, marker] of markers.entries()) {
    const saved = await call("POST", "/api/commands/save", {
      command: {
        name: `Redacted ${index}`,
        hosts: ["agent-host"],
        argv: ["tool", marker],
      },
    });
    expect(saved.status).toBe(400);
  }

  const refused = await call("POST", "/api/exec", {
    host: "agent-host",
    argv: ["rm", "fixture"],
  });
  expect(refused.status).toBe(409);
  expect(await readFile(configPath, "utf8")).toBe("preserve this file");
});

test("invalid saved commands are surfaced by the commands API", async () => {
  const { call, running } = await panel();
  await writeFile(
    running.hub.savedCommands.path,
    JSON.stringify({
      version: 1,
      commands: { broken: { id: "broken", name: "x".repeat(81) } },
    }),
  );
  const response = await call("GET", "/api/commands");
  const result = (await response.json()) as {
    commands: { id: string; status?: string; reason?: string }[];
  };
  expect(result.commands).toEqual([
    expect.objectContaining({
      id: "broken",
      status: "invalid",
      reason: expect.any(String),
    }),
  ]);
  const removed = await call("POST", "/api/commands/remove", { id: "broken" });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ removed: "broken" });
  const refreshed = await call("GET", "/api/commands");
  expect(await refreshed.json()).toEqual({ commands: [] });
});

test("a corrupt saved-command file is reported without rewriting it", async () => {
  const { call, running } = await panel();
  const corrupt = "{ this is not valid saved-command data\n";
  await writeFile(running.hub.savedCommands.path, corrupt);

  const response = await call("GET", "/api/commands");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    commands: [
      {
        id: "saved-commands",
        status: "invalid",
        reason: expect.stringContaining("corrupt"),
      },
    ],
  });
  expect(await readFile(running.hub.savedCommands.path, "utf8")).toBe(corrupt);
});

test("API exec is serialized with machine saves", async () => {
  let signalRunnerStarted!: () => void;
  let releaseRunner!: () => void;
  const runnerStarted = new Promise<void>((resolve) => {
    signalRunnerStarted = resolve;
  });
  const runnerGate = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const { call } = await panel({
    access: "full",
    session: true,
    operationRunner: async () => {
      signalRunnerStarted();
      await runnerGate;
      return { exitCode: 0, stdout: "done", stderr: "" };
    },
  });
  const execution = call("POST", "/api/exec", {
    host: "agent-host",
    argv: ["hostname"],
  });
  await runnerStarted;
  let saveResolved = false;
  const saving = call("POST", "/api/machine/save", {
    name: "new-host",
    machine: {
      description: "Synthetic SSH host",
      transport: "ssh",
      access: "user",
      ssh_alias: "new-host",
      address: "192.0.2.1",
      user: "test",
      port: 22,
    },
  }).then((result) => {
    saveResolved = true;
    return result;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(saveResolved).toBe(false);
  } finally {
    releaseRunner();
  }
  const [executionResponse, saveResponse] = await Promise.all([
    execution,
    saving,
  ]);
  expect(executionResponse.status).toBe(200);
  expect(saveResponse.status).toBe(200);
});

test("saved-command runs are serialized with machine saves", async () => {
  let signalRunnerStarted!: () => void;
  let releaseRunner!: () => void;
  const runnerStarted = new Promise<void>((resolve) => {
    signalRunnerStarted = resolve;
  });
  const runnerGate = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const { call } = await panel({
    session: true,
    operationRunner: async () => {
      signalRunnerStarted();
      await runnerGate;
      return { exitCode: 0, stdout: "done", stderr: "" };
    },
  });
  const saved = await call("POST", "/api/commands/save", {
    command: {
      name: "Hostname",
      hosts: ["agent-host"],
      argv: ["hostname"],
    },
  });
  const { command } = (await saved.json()) as { command: { id: string } };
  const execution = call("POST", "/api/commands/run", {
    id: command.id,
    host: "agent-host",
    parameters: {},
    dryRun: false,
  });
  await runnerStarted;
  let saveResolved = false;
  const saving = call("POST", "/api/machine/save", {
    name: "new-host",
    machine: {
      description: "Synthetic SSH host",
      transport: "ssh",
      access: "user",
      ssh_alias: "new-host",
      address: "192.0.2.1",
      user: "test",
      port: 22,
    },
  }).then((result) => {
    saveResolved = true;
    return result;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(saveResolved).toBe(false);
  } finally {
    releaseRunner();
  }
  const [executionResponse, saveResponse] = await Promise.all([
    execution,
    saving,
  ]);
  expect(executionResponse.status).toBe(200);
  expect(saveResponse.status).toBe(200);
});
