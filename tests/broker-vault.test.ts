// Broker vault (homelab #21 B7/B8, A3): the vault master password is the owner
// credential; sign-in unlocks and loads only non-admin keys; elevation loads
// admin keys for the privileged window; lock clears the agent, ends owner
// sessions, cancels queued approvals and stops dispatch; a restart starts
// locked with admin keys still locked.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths, type Endpoint } from "../src/broker/paths";
import type { KeyAgentPort } from "../src/broker/vault-service";
import { saveInventory } from "../src/inventory";
import { ADMIN_TAG, createDatabase, passwordSource } from "../src/vault";

const PASSWORD = "vault master password for tests";
const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
let dir: string;
let inventoryPath: string;
const stops: (() => Promise<void>)[] = [];

interface AgentLog {
  starts: number;
  added: (number | undefined)[];
  clears: number;
}

function fakeAgent(log: AgentLog): KeyAgentPort {
  return {
    start: async () => {
      log.starts += 1;
    },
    add: async (_key, lifetime) => {
      log.added.push(lifetime);
    },
    putSecret: async () => undefined,
    clear: async () => {
      log.clears += 1;
    },
  };
}

async function addKey(
  database: Awaited<ReturnType<typeof createDatabase>>,
  title: string,
  admin: boolean,
) {
  const pem = generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  const entry = database.db.createEntry(database.db.getDefaultGroup());
  entry.fields.set("Title", title);
  if (admin) entry.tags = [ADMIN_TAG];
  entry.binaries.set(
    "id_ed25519",
    await database.db.createBinary(Uint8Array.from(Buffer.from(pem)).buffer),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-broker-vault-"));
  inventoryPath = join(dir, "inventory.yaml");
  const auth = (entry: string) => ({
    type: "keepassxc" as const,
    inventory: inventoryPath,
    entry,
    socket: join(dir, "inventory.yaml.session", "agent.sock"),
    public_key: join(dir, "public-keys", `${entry}.pub`),
  });
  await saveInventory(inventoryPath, {
    version: 1,
    session: { ttl: "24h", database: join(dir, "homelab.kdbx") },
    machines: {
      web: {
        description: "web",
        transport: "ssh",
        access: "user",
        ssh_alias: "web",
        address: "web.example.invalid",
        user: "op",
        auth: auth("homectl-web"),
      },
      core: {
        description: "core",
        transport: "ssh",
        access: "user",
        ssh_alias: "core",
        address: "core.example.invalid",
        user: "op",
        auth: auth("homectl-core"),
      },
    },
  });
  const database = await createDatabase(
    join(dir, "homelab.kdbx"),
    passwordSource(PASSWORD),
    { argon2: SMALL },
  );
  await addKey(database, "homectl-web", false);
  await addKey(database, "homectl-core", true);
  await database.save();
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await rm(dir, { recursive: true, force: true });
});

async function start(log: AgentLog) {
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    keyAgent: fakeAgent(log),
    executor: {
      run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    },
  });
  stops.push(daemon.stop);
  return daemon;
}

async function signIn(endpoint: Endpoint, password = PASSWORD) {
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password },
    { endpoint },
  );
  return { endpoint, authorization: `Owner ${token}` };
}

test("vault password signs in, loads only non-admin keys, and lock stops everything", async () => {
  const log: AgentLog = { starts: 0, added: [], clears: 0 };
  const daemon = await start(log);
  const { endpoint } = daemon;
  await expect(signIn(endpoint, "not the password")).rejects.toThrow(
    "Wrong owner password",
  );
  const asOwner = await signIn(endpoint);
  expect(log.starts).toBe(1);
  expect(log.added.length).toBe(1);

  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex-pc", name: "Codex", hosts: ["web"], password: PASSWORD },
    asOwner,
  );
  const asAgent = { endpoint, authorization: `Bearer ${created.token}` };
  const safe = await callBroker<{ state: string }>(
    "/v1/exec",
    { host: "web", argv: ["uptime"], waitMs: 5000 },
    asAgent,
  );
  expect(safe.state).toBe("succeeded");
  const queued = await callBroker<{ id: string; state: string }>(
    "/v1/exec",
    { host: "web", argv: ["systemctl", "--user", "restart", "app"] },
    asAgent,
  );
  expect(queued.state).toBe("awaiting-approval");

  // Elevation needs the password again and loads the admin key for at most
  // the privileged window (10 minutes).
  const elevated = await callBroker<{ adminKeysLoaded: number }>(
    "/v1/owner/vault/elevate",
    { password: PASSWORD },
    asOwner,
  );
  expect(elevated.adminKeysLoaded).toBe(1);
  expect(log.added[1]).toBeLessThanOrEqual(600);

  await callBroker("/v1/owner/vault/lock", {}, asOwner);
  await Bun.sleep(100);
  expect(log.clears).toBeGreaterThanOrEqual(1);
  // Owner sessions end with the lock.
  await expect(callBroker("/v1/owner/pending", {}, asOwner)).rejects.toThrow(
    "Owner sign-in required",
  );
  const cancelled = await callBroker<{ state: string; reason: string }>(
    "/v1/status",
    { id: queued.id },
    asAgent,
  );
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.reason).toStartWith("vault-locked");
  const refused = await callBroker<{ state: string; reason: string }>(
    "/v1/exec",
    { host: "web", argv: ["uptime"], waitMs: 5000 },
    asAgent,
  );
  expect(refused.state).toBe("failed");
  expect(refused.reason).toBe("vault-locked");
});

test("a restart starts locked and admin keys stay locked after sign-in", async () => {
  const first: AgentLog = { starts: 0, added: [], clears: 0 };
  const daemon = await start(first);
  await signIn(daemon.endpoint);
  await callBroker(
    "/v1/owner/vault/elevate",
    { password: PASSWORD },
    await signIn(daemon.endpoint),
  );
  expect(first.added.length).toBe(2);
  await stops.pop()?.();
  // Shutdown clears the broker's agent.
  expect(first.clears).toBeGreaterThanOrEqual(1);

  const second: AgentLog = { starts: 0, added: [], clears: 0 };
  const again = await start(second);
  const status = await callBroker<{ unlocked: boolean }>(
    "/v1/owner/vault/status",
    {},
    await signIn(again.endpoint),
  );
  expect(status.unlocked).toBe(true);
  expect(second.added.length).toBe(1);
});
