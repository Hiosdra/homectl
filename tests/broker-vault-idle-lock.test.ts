// Overnight approval semantics (homelab #21): an automatic idle lock still
// clears the agent, ends owner sessions and blocks dispatch, but unapproved
// requests survive until their approval window expires and require a fresh
// owner sign-in and approval before running. Explicit manual and absolute
// locks still cancel pending approvals.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths, type Endpoint } from "../src/broker/paths";
import type { OperationView } from "../src/broker/types";
import { saveInventory } from "../src/inventory";
import { createDatabase, passwordSource } from "../src/vault";

const PASSWORD = "idle lock fixture password";
const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
let dir: string | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function setupFixture(session: { ttl: string; idle: string }) {
  dir = await mkdtemp(join(tmpdir(), "homectl-idle-lock-"));
  const inventoryPath = join(dir, "inventory.yaml");
  const vaultPath = join(dir, "homelab.kdbx");
  await saveInventory(inventoryPath, {
    version: 1,
    session: { ...session, database: vaultPath },
    machines: {
      web: {
        description: "web",
        transport: "ssh",
        access: "user",
        ssh_alias: "web",
        address: "web.example.invalid",
        user: "op",
        auth: {
          type: "keepassxc",
          inventory: inventoryPath,
          entry: "homectl-web",
          socket: join(dir, "inventory.yaml.session", "agent.sock"),
          public_key: join(dir, "public-keys", "homectl-web.pub"),
        },
      },
    },
  });
  const database = await createDatabase(vaultPath, passwordSource(PASSWORD), {
    argon2: SMALL,
  });
  await database.save();

  let clock = Date.now();
  let clears = 0;
  let ran = 0;
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    now: () => clock,
    keyAgent: {
      start: async () => undefined,
      add: async () => undefined,
      putSecret: async () => undefined,
      clear: async () => {
        clears += 1;
      },
    },
    executor: {
      run: async () => {
        ran += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  stop = daemon.stop;
  const signIn = async (endpoint: Endpoint) => {
    const { token } = await callBroker<{ token: string }>(
      "/v1/owner/login",
      { password: PASSWORD },
      { endpoint },
    );
    return { endpoint, authorization: `Owner ${token}` };
  };
  return {
    daemon,
    signIn,
    advance: (ms: number) => {
      clock += ms;
    },
    clears: () => clears,
    ran: () => ran,
  };
}

test("pending approvals survive an automatic idle lock but require fresh owner sign-in and approval", async () => {
  const fixture = await setupFixture({ ttl: "24h", idle: "5m" });
  const { endpoint } = fixture.daemon;
  const firstOwner = await fixture.signIn(endpoint);
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "overnight-agent",
      name: "Overnight",
      hosts: ["web"],
      password: PASSWORD,
    },
    firstOwner,
  );
  const agent = { endpoint, authorization: `Bearer ${token}` };

  const queued = await callBroker<OperationView>(
    "/v1/exec",
    { host: "web", argv: ["systemctl", "--user", "restart", "app"] },
    agent,
  );
  expect(queued.state).toBe("awaiting-approval");

  // Advance past the 5m idle timeout without exceeding the 24h absolute TTL.
  fixture.advance(6 * 60_000);
  // Safe auto-approved work triggers the lock check and fails while locked.
  const blocked = await callBroker<OperationView>(
    "/v1/exec",
    { host: "web", argv: ["uptime"], waitMs: 5000 },
    agent,
  );
  expect(blocked.state).toBe("failed");
  expect(blocked.reason).toBe("vault-locked");
  await Bun.sleep(50);

  expect(fixture.clears()).toBeGreaterThanOrEqual(1);
  await expect(callBroker("/v1/owner/pending", {}, firstOwner)).rejects.toThrow(
    "Owner sign-in required",
  );

  // The pending request survived the idle lock, and nothing has executed.
  const stillPending = await callBroker<OperationView>(
    "/v1/status",
    { id: queued.id },
    agent,
  );
  expect(stillPending.state).toBe("awaiting-approval");
  expect(fixture.ran()).toBe(0);

  // Fresh owner sign-in unlocks the vault and lets the owner approve it.
  const freshOwner = await fixture.signIn(endpoint);
  const pending = await callBroker<OperationView[]>(
    "/v1/owner/pending",
    {},
    freshOwner,
  );
  expect(pending.map((op) => op.id)).toContain(queued.id);

  await callBroker(
    "/v1/owner/decide",
    {
      operationId: queued.id,
      fingerprint: queued.fingerprint,
      decision: "approve-once",
      password: PASSWORD,
    },
    freshOwner,
  );
  const finished = await callBroker<OperationView>(
    "/v1/wait",
    { id: queued.id, timeoutMs: 5000 },
    agent,
  );
  expect(finished.state).toBe("succeeded");
  expect(fixture.ran()).toBe(1);
});

test("absolute vault TTL expiry still cancels pending approvals", async () => {
  const fixture = await setupFixture({ ttl: "2h", idle: "1h" });
  const { endpoint } = fixture.daemon;
  const owner = await fixture.signIn(endpoint);
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "overnight-agent",
      name: "Overnight",
      hosts: ["web"],
      password: PASSWORD,
    },
    owner,
  );
  const agent = { endpoint, authorization: `Bearer ${token}` };

  const queued = await callBroker<OperationView>(
    "/v1/exec",
    { host: "web", argv: ["systemctl", "--user", "restart", "app"] },
    agent,
  );
  expect(queued.state).toBe("awaiting-approval");

  // Advance past the 2h absolute TTL.
  fixture.advance(3 * 60 * 60_000);
  const blocked = await callBroker<OperationView>(
    "/v1/exec",
    { host: "web", argv: ["uptime"], waitMs: 5000 },
    agent,
  );
  expect(blocked.state).toBe("failed");
  expect(blocked.reason).toBe("vault-locked");
  await Bun.sleep(50);

  const cancelled = await callBroker<OperationView>(
    "/v1/status",
    { id: queued.id },
    agent,
  );
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.reason).toBe("vault-locked:absolute");
});
