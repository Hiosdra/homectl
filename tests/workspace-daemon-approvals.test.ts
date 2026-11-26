import {
  afterEach,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicPolicy } from "../src/broker/basic-policy";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import type { OperationView } from "../src/broker/types";

const PASSWORD = "disposable workspace approval password";
const INVENTORY =
  "version: 1\nmachines:\n  fixture:\n    description: Local fixture\n    transport: local\n    access: user\n";
const CHANGE = ["systemctl", "restart", "fixture.service"];
let dir: string;
let dispatches: string[][];
const stops: (() => Promise<void>)[] = [];
setDefaultTimeout(30_000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-workspace-approval-"));
  dispatches = [];
});
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await rm(dir, { recursive: true, force: true });
});

async function device(name: string, serverPort?: number) {
  const workspace = join(dir, name);
  await mkdir(workspace, { recursive: true });
  const inventoryPath = join(workspace, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const paths = compatPaths(inventoryPath);
  const daemon = await startDaemon({
    ...paths,
    mode: "compat",
    inventoryPath,
    sshConfigPath: join(workspace, "ssh_config"),
    policy: new BasicPolicy(),
    executor: {
      async run({ argv }) {
        dispatches.push(argv);
        return { exitCode: 0, stdout: "fixture", stderr: "" };
      },
    },
    ...(serverPort === undefined
      ? {}
      : {
          workspace: {
            server: { listen: { hostname: "127.0.0.1", port: serverPort } },
          },
        }),
  });
  let started = true;
  async function stop() {
    if (!started) return;
    started = false;
    await daemon.stop();
  }
  stops.push(stop);
  await new FileVerifier(join(paths.state, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  }).set(PASSWORD);
  const endpoint = daemon.endpoint;
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint },
  );
  return {
    ...daemon,
    stop,
    owner: <T>(route: string, input: Record<string, unknown> = {}) =>
      callBroker<T>(
        `/v1/owner/${route}`,
        { password: PASSWORD, ...input },
        {
          endpoint,
          authorization: `Owner ${token}`,
        },
      ),
  };
}

async function linked() {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("No workspace port");
  const server = await device("central", port);
  const origin = await device("origin");
  const { code } = await server.owner<{ code: string }>("workspace/invite");
  await origin.owner("workspace/join", {
    address: `http://127.0.0.1:${port}`,
    code,
    remoteApproval: true,
  });
  const { clientId } = await origin.owner<{ clientId: string }>(
    "workspace/status",
  );
  const { token } = await origin.owner<{ token: string }>("clients/create", {
    id: "fixture-agent",
    name: "Fixture agent",
    hosts: ["fixture"],
  });
  const op = await callBroker<OperationView>(
    "/v1/exec",
    { host: "fixture", argv: CHANGE },
    {
      endpoint: origin.endpoint,
      authorization: `Bearer ${token}`,
    },
  );
  expect(op.state).toBe("awaiting-approval");
  await origin.owner("workspace/sync-now");
  expect(await server.owner("workspace/pending")).toMatchObject([
    { id: op.id, origin: clientId, stepUp: false },
  ]);
  const target = { operationId: op.id, fingerprint: op.fingerprint };
  return { origin, server, port, clientId, op, target };
}

test("the central panel records the origin's refusal after the requester is revoked", async () => {
  const { origin, server, clientId, op, target } = await linked();
  await server.owner("workspace/decide", {
    ...target,
    client: clientId,
    decision: "approve-once",
  });
  await origin.owner("clients/revoke", { id: "fixture-agent" });
  await origin.owner("workspace/sync-now");
  expect(await origin.broker.operation(op.id)).toMatchObject({
    state: "failed",
    reason: "client-grant-changed",
  });
  expect(
    await server.owner("workspace/intents", { client: clientId }),
  ).toMatchObject({
    intents: [
      { operationId: op.id, status: "refused", reason: "client-grant-changed" },
    ],
  });
  expect(dispatches).toEqual([]);
});

test("a local approval racing a central denial has a single origin outcome", async () => {
  const { origin, server, clientId, op, target } = await linked();
  await server.owner("workspace/decide", {
    ...target,
    client: clientId,
    decision: "deny-once",
  });
  const [local, sync] = await Promise.allSettled([
    origin.owner("decide", { ...target, decision: "approve-once" }),
    origin.owner("workspace/sync-now"),
  ]);
  expect(sync.status).toBe("fulfilled");
  await origin.broker.settled();
  await origin.owner("workspace/sync-now");
  const terminal = await origin.broker.operation(op.id);
  const appliedLocally = local.status === "fulfilled";
  expect(terminal?.state).toBe(appliedLocally ? "succeeded" : "denied");
  expect(dispatches).toEqual(appliedLocally ? [CHANGE] : []);
  expect(
    await server.owner("workspace/intents", { client: clientId }),
  ).toMatchObject({
    intents: [
      { operationId: op.id, status: appliedLocally ? "refused" : "applied" },
    ],
  });
  expect(await server.owner("workspace/pending")).toEqual([]);
});

test("local execution continues while the server is down, and reconnect refuses a stale decision", async () => {
  const { origin, server, port, clientId, op, target } = await linked();
  await server.owner("workspace/decide", {
    ...target,
    client: clientId,
    decision: "approve-once",
  });
  await server.stop();
  await expect(origin.owner("workspace/sync-now")).rejects.toThrow();
  await origin.owner("decide", { ...target, decision: "approve-once" });
  await origin.broker.settled();
  expect(await origin.broker.operation(op.id)).toMatchObject({
    state: "succeeded",
  });
  expect(dispatches).toEqual([CHANGE]);

  const restarted = await device("central", port);
  await origin.owner("workspace/sync-now");
  expect(
    await restarted.owner("workspace/intents", { client: clientId }),
  ).toMatchObject({
    intents: [{ operationId: op.id, status: "refused" }],
  });
  expect(await restarted.owner("workspace/pending")).toEqual([]);
  expect(dispatches).toEqual([CHANGE]);
});
