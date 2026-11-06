import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpServer } from "../src/control/mcp";
import type { ClientIdentity } from "../src/control/types";
import { localApi } from "../src/peer/local-api";
import { defaults } from "../src/peer/store";
import { serve } from "../src/serve";
import { HomectlError } from "../src/types";

setDefaultTimeout(120_000);

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const CHANGE = ["systemctl", "restart", "nginx"];
const dirs: string[] = [];
const stops: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// The inventory path lets the test reach the local admin routes through the
// same launch-token gate the CLI uses.
type Server = Awaited<ReturnType<typeof serve>> & { inventory: string };

// A real serve() instance on loopback. Commands never spawn: the runner is a fake.
async function server(name: string): Promise<Server> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-e2e-"));
  dirs.push(dir);
  const inventory = join(dir, "inventory.yaml");
  await writeFile(inventory, INVENTORY);
  const s = await serve({
    inventoryPath: inventory,
    configPath: `${inventory}.ssh_config`,
    port: 0,
    peerPort: 0,
    discover: false,
    controlRunner: async () => ({ exitCode: 0, stdout: "demo\n", stderr: "" }),
  });
  s.hub.state.name = name;
  await s.hub.save();
  stops.push(() => s.stop());
  return Object.assign(s, { inventory });
}

// The same sequence the existing peer tests use: open, join with the code, confirm on both.
async function pair(a: Server, b: Server): Promise<void> {
  await a.hub.openPair();
  await b.hub.join(a.address, a.hub.pair?.code ?? "");
  await b.hub.confirm(defaults());
  await a.hub.confirm(defaults());
  await b.hub.pollPair();
  expect(Object.keys(a.hub.state.peers)).toHaveLength(1);
  expect(Object.keys(b.hub.state.peers)).toHaveLength(1);
}

async function rounds(...servers: Server[]): Promise<void> {
  for (let i = 0; i < 2; i++) for (const s of servers) await s.syncNow();
}

async function identity(
  s: Server,
  id: string,
  scopes: string[],
): Promise<{ token: string; client: ClientIdentity }> {
  const created = await s.control.createClient({
    id,
    name: id,
    scopes,
    hosts: ["agent-host"],
  });
  const client = await s.control.authenticate(created.token);
  if (!client) throw new Error("token did not authenticate");
  return { token: created.token, client };
}

async function mcpCall(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return (await response.json()).result as {
    isError: boolean;
    content: { text: string }[];
    structuredContent?: Record<string, unknown>;
  };
}

async function expectRefused(
  promise: Promise<unknown>,
  code: number,
  text?: string,
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HomectlError);
  expect((caught as HomectlError).code).toBe(code);
  if (text) expect((caught as HomectlError).message).toContain(text);
}

describe("cooperative handoff over the real peer channel", () => {
  test("offer on the owner, accept on the receiver, and the owner stops running it", async () => {
    const A = await server("Linux");
    const B = await server("Windows");
    await pair(A, B);
    const codex = await identity(A, "codex-pc", ["plan:create", "status:read"]);
    await rounds(A, B);
    const made = (await A.control.request(
      { kind: "client", client: codex.client },
      { op: "plan", host: "agent-host", argv: ["hostname"] },
    )) as { operationId: string };
    await rounds(A, B);

    // The owner offers through its local admin route (the CLI's path).
    const offered = await localApi<{ offered: boolean; to: string }>(
      A.inventory,
      "/api/control/handoff",
      { operationId: made.operationId, to: "Windows" },
    );
    expect(offered).toMatchObject({ offered: true, to: B.hub.state.id });
    // From the offer on, the owner refuses to run it.
    await expectRefused(
      A.control.request(
        { kind: "local-operator" },
        { op: "execute", operationId: made.operationId },
      ),
      3,
      "Handoff offered to Windows",
    );
    await rounds(A, B);

    // The receiver accepts through its own admin route.
    const accepted = await localApi<{ accepted: boolean }>(
      B.inventory,
      "/api/control/handoff",
      { operationId: made.operationId },
    );
    expect(accepted.accepted).toBe(true);
    await rounds(A, B);
    await expectRefused(
      A.control.request(
        { kind: "local-operator" },
        { op: "execute", operationId: made.operationId },
      ),
      3,
      "now belongs to Windows",
    );
    const onB = (await B.control.listOperations({ all: true })).find(
      (op) => op.operationId === made.operationId,
    );
    expect(onB?.state).toBe("pending");
  });

  test("offer then cancel: the owner runs again, and the receiver's accept is refused", async () => {
    const A = await server("Linux");
    const B = await server("Windows");
    await pair(A, B);
    const codex = await identity(A, "codex-pc", ["plan:create", "status:read"]);
    await rounds(A, B);
    const made = (await A.control.request(
      { kind: "client", client: codex.client },
      { op: "plan", host: "agent-host", argv: ["hostname"] },
    )) as { operationId: string };
    await rounds(A, B);
    await localApi(A.inventory, "/api/control/handoff", {
      operationId: made.operationId,
      to: "Windows",
    });
    await rounds(A, B);
    const cancelled = await localApi<{ cancelled: boolean }>(
      A.inventory,
      "/api/control/handoff",
      { operationId: made.operationId, cancel: true },
    );
    expect(cancelled.cancelled).toBe(true);
    await rounds(A, B);

    await expect(
      localApi(B.inventory, "/api/control/handoff", {
        operationId: made.operationId,
      }),
      // No offer is open for B any more, so B falls back to a takeover, which the reachable owner refuses.
    ).rejects.toMatchObject({
      code: 3,
      message: expect.stringContaining("Takeover possible after"),
    });
    const ran = (await A.control.request(
      { kind: "local-operator" },
      { op: "execute", operationId: made.operationId },
    )) as { operation: { state: string } };
    expect(ran.operation.state).toBe("succeeded");
  });

  test("a paired device with a signing key shows in the sync status with no conflicts", async () => {
    const A = await server("Linux");
    const B = await server("Windows");
    await pair(A, B);
    await rounds(A, B);
    const view = await localApi<{
      running: boolean;
      peers: { name: string; excluded?: boolean; leaseOk: boolean }[];
      conflicts: unknown[];
    }>(A.inventory, "/api/control/sync");
    expect(view.running).toBe(true);
    expect(view.peers).toEqual([
      expect.objectContaining({ name: "Windows", leaseOk: true }),
    ]);
    expect(view.peers[0]?.excluded).toBeUndefined();
    expect(view.conflicts).toEqual([]);
  });
});

describe("control-plane convergence over the real peer channel", () => {
  test("plan on A, approve through MCP on B, execute on A, result visible on B, replays and revocation refused", async () => {
    const A = await server("Linux");
    const B = await server("Windows");
    await pair(A, B);

    const codex = await identity(A, "codex-pc", ["plan:create", "status:read"]);
    const hermes = await identity(B, "hermes-admin", [
      "approve:decide",
      "status:read",
    ]);
    await rounds(A, B);

    // Plan on A (the owner: the device whose MCP endpoint received the plan).
    const plan = (await A.control.request(
      { kind: "client", client: codex.client },
      { op: "plan", host: "agent-host", argv: CHANGE },
    )) as { operationId: string; fingerprint: string };
    await rounds(A, B);
    expect(B.replicator?.replica.ops[plan.operationId]?.state).toBe("pending");

    // Approve through MCP on B. The decision is signed on B and forwarded.
    const mcp = startMcpServer({ control: B.control, port: 0 });
    stops.push(() => mcp.stop());
    const approved = await mcpCall(mcp.url, hermes.token, "homectl_approve", {
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    expect(approved.isError).toBe(false);
    expect(approved.content[0]?.text).toContain(
      "Approval forwarded to owner Linux",
    );
    expect(approved.content[0]?.text).toContain(
      "it applies after the next sync",
    );
    // B shows the operation as held by Linux, with its approval still in flight.
    const onB = async () =>
      (await B.control.listOperations({ all: true })).find(
        (op) => op.operationId === plan.operationId,
      );
    expect((await onB())?.runsOn).toBe("Linux");
    expect((await onB())?.delivery?.status).toBe("awaiting-confirmation");

    await rounds(A, B);
    expect(B.replicator?.replica.ops[plan.operationId]?.state).toBe("approved");
    // Once the owner's replicated state reflects the decision, it is confirmed.
    expect((await onB())?.delivery?.status).toBe("approved");
    expect((await onB())?.approvedBy).toBe("hermes-admin (via Windows)");

    // Execute on the owner, then the result is visible on B.
    const ran = (await A.control.request(
      { kind: "local-operator" },
      { op: "execute", operationId: plan.operationId },
    )) as { operation: { state: string } };
    expect(ran.operation.state).toBe("succeeded");
    await rounds(A, B);
    expect(B.replicator?.replica.ops[plan.operationId]?.state).toBe(
      "succeeded",
    );

    // A second execute is refused on the owner, and B cannot execute at all.
    await expectRefused(
      A.control.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
    );
    await expectRefused(
      B.control.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
      "runs on Linux",
    );

    // Revocation of B's client propagates to A; its later decision is not applied.
    const second = (await A.control.request(
      { kind: "client", client: codex.client },
      {
        op: "plan",
        host: "agent-host",
        argv: ["systemctl", "restart", "sshd"],
      },
    )) as { operationId: string; fingerprint: string };
    await rounds(A, B);
    await B.control.revokeClient("hermes-admin");
    const revokedToken = await fetch(mcp.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hermes.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(revokedToken.status).toBe(401);
    await rounds(A, B);
    expect(A.replicator?.replica.clients["hermes-admin"]?.revoked).toBe(true);
    await B.replicator?.decide(
      hermes.client,
      second.operationId,
      second.fingerprint,
      "approve",
    );
    await rounds(A, B);
    expect(A.replicator?.replica.ops[second.operationId]?.state).toBe(
      "pending",
    );
    expect(B.replicator?.replica.ops[second.operationId]?.state).toBe(
      "pending",
    );
  });

  test("after real rounds, each paired peer shows a last-sync time and nothing is blocked", async () => {
    const A = await server("Linux");
    const B = await server("Windows");
    await pair(A, B);
    await rounds(A, B);
    expect(A.syncNow).toBeDefined();
    const statuses = (await A.syncNow().then(() => A.replicator?.status())) ?? {
      peers: [],
      blocked: {},
      conflicts: [],
    };
    expect(statuses.peers[0]?.lastSync).toBeDefined();
    expect(statuses.blocked).toEqual({});
  });
});
