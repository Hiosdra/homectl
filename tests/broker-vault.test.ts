// Broker vault (homelab #21 B7/B8, A3): the vault master password is the owner
// credential; sign-in unlocks and loads only non-admin keys; elevation loads
// admin keys for the privileged window; lock clears the agent, ends owner
// sessions, cancels queued approvals and stops dispatch; a restart starts
// locked with admin keys still locked.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths, type Endpoint } from "../src/broker/paths";
import {
  REVIEWER_KEY_ENTRY,
  REVIEWER_KEY_FIELD,
} from "../src/broker/reviewer-key";
import type { KeyAgentPort } from "../src/broker/vault-service";
import { saveInventory } from "../src/inventory";
import {
  ADMIN_TAG,
  createDatabase,
  openDatabase,
  passwordSource,
} from "../src/vault";
import {
  findUnique,
  managedEntries,
  readFields,
  readSshKey,
} from "../src/vault/entries";

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

async function start(log: AgentLog, realSetup = false) {
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    keyAgent: fakeAgent(log),
    ...(realSetup
      ? {}
      : {
          executor: {
            run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          },
        }),
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

test("an agent can request a new machine key, but only the owner can create or read it", async () => {
  const daemon = await start({ starts: 0, added: [], clears: 0 }, true);
  const owner = await signIn(daemon.endpoint);
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "setup-agent",
      name: "Setup agent",
      hosts: ["web"],
      password: PASSWORD,
    },
    owner,
  );
  const agent = { endpoint: daemon.endpoint, authorization: `Bearer ${token}` };
  const request = await callBroker<{
    id: string;
    fingerprint: string;
    state: string;
  }>("/v1/setup/request/create-key", { name: "new-box" }, agent);
  expect(request.state).toBe("awaiting-approval");
  const keyStatus = () =>
    callBroker<{ present: boolean; publicKey?: string }>(
      "/v1/owner/hosts/key-status",
      { name: "new-box" },
      owner,
    );
  expect((await keyStatus()).present).toBe(false);
  await expect(
    callBroker("/v1/owner/hosts/key-status", { name: "new-box" }, agent),
  ).rejects.toThrow();
  const decision = {
    operationId: request.id,
    fingerprint: request.fingerprint,
    decision: "approve-once",
  };
  await expect(
    callBroker("/v1/owner/decide", decision, owner),
  ).rejects.toThrow();
  expect((await keyStatus()).present).toBe(false);
  await callBroker(
    "/v1/owner/decide",
    { ...decision, password: PASSWORD },
    owner,
  );
  const result = await callBroker<{
    state: string;
    result: { stdout: string };
  }>("/v1/wait", { id: request.id, timeoutMs: 5000 }, agent);
  expect(result.state).toBe("succeeded");
  const projected = await keyStatus();
  expect(projected.publicKey).toMatch(/^ssh-ed25519 /);
  expect(result.result.stdout).not.toContain(projected.publicKey ?? "");
  await callBroker(
    "/v1/owner/hosts/create-key",
    { name: "new-box", password: PASSWORD },
    owner,
  );
  expect(await keyStatus()).toEqual(projected);
  const database = await openDatabase(
    join(dir, "homelab.kdbx"),
    passwordSource(PASSWORD),
  );
  const entry = findUnique(managedEntries(database.db), "homectl-new-box");
  if (!entry) throw new Error("Key not persisted in the vault");
  const privateKey = readSshKey(entry);
  try {
    expect(privateKey.publicKey).toBe(projected.publicKey ?? "");
  } finally {
    privateKey.privateKey.fill(0);
  }
});

test("an AI helper setup approval keeps its key private and applies the reviewed destination once", async () => {
  const first = "fixture-ai-helper-key-first";
  const second = "fixture-ai-helper-key-second";
  const daemon = await start({ starts: 0, added: [], clears: 0 }, true);
  const owner = await signIn(daemon.endpoint);
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "helper-agent",
      name: "Helper agent",
      hosts: ["web"],
      password: PASSWORD,
    },
    owner,
  );
  const agent = { endpoint: daemon.endpoint, authorization: `Bearer ${token}` };
  const requestBody = { provider: "openai", model: "fixture-model" };
  const path = "/v1/setup/request/ai-helper";
  await expect(
    callBroker(path, { ...requestBody, apiKey: first }, agent),
  ).rejects.toThrow("Unknown field");
  const request = await callBroker<{
    id: string;
    fingerprint: string;
    state: string;
  }>(path, requestBody, agent);
  expect(request.state).toBe("awaiting-approval");
  const review = await callBroker("/v1/owner/pending", {}, owner);
  expect(review).toMatchObject([
    {
      setup: {
        input: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1/chat/completions",
          model: "fixture-model",
        },
      },
    },
  ]);
  const decision = {
    operationId: request.id,
    fingerprint: request.fingerprint,
    decision: "approve-once",
  };
  await expect(
    callBroker("/v1/owner/decide", { ...decision, password: PASSWORD }, owner),
  ).rejects.toThrow("originating device");
  await expect(
    callBroker(
      "/v1/owner/decide",
      { ...decision, password: "bad", reviewerApiKey: first },
      owner,
    ),
  ).rejects.toThrow("Wrong owner password");
  await expect(
    callBroker(
      "/v1/owner/decide",
      { ...decision, reviewerApiKey: first },
      agent,
    ),
  ).rejects.toThrow();
  const results = await Promise.allSettled(
    [first, second].map((reviewerApiKey) =>
      callBroker(
        "/v1/owner/decide",
        { ...decision, password: PASSWORD, reviewerApiKey },
        owner,
      ),
    ),
  );
  const successAt = results.findIndex((item) => item.status === "fulfilled");
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const result = await callBroker<{ state: string }>(
    "/v1/wait",
    { id: request.id, timeoutMs: 5000 },
    agent,
  );
  expect(result.state).toBe("succeeded");
  const database = await openDatabase(
    join(dir, "homelab.kdbx"),
    passwordSource(PASSWORD),
  );
  const entry = findUnique(managedEntries(database.db), REVIEWER_KEY_ENTRY);
  if (!entry) throw new Error("AI helper key was not persisted");
  expect(readFields(entry)[REVIEWER_KEY_FIELD]).toBe(
    [first, second][successAt],
  );
  const state = compatPaths(inventoryPath).state;
  for (const response of [request, review, results, result]) {
    expect(JSON.stringify(response)).not.toContain(first);
    expect(JSON.stringify(response)).not.toContain(second);
  }
  const operations = await readFile(join(state, "broker-state.json"), "utf8");
  expect(operations).not.toContain(first);
  expect(operations).not.toContain(second);
  const settings = await readFile(join(state, "reviewer.json"), "utf8");
  expect(settings).toContain("https://api.openai.com/v1/chat/completions");
  expect(settings).not.toContain(first);
  expect(settings).not.toContain(second);
});

test("saving a requested value uses the encrypted vault, and delivery stops while locked", async () => {
  const value = "fixture-saved-secret";
  const daemon = await start({ starts: 0, added: [], clears: 0 });
  const owner = await signIn(daemon.endpoint);
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "secret-agent",
      name: "Secret agent",
      hosts: ["web"],
      password: PASSWORD,
    },
    owner,
  );
  const agent = { endpoint: daemon.endpoint, authorization: `Bearer ${token}` };
  const destination = {
    kind: "ssh-stdin",
    host: "web",
    argv: ["fixture-receive"],
  };
  const request = await callBroker<{ id: string }>(
    "/v1/secret/request",
    {
      purpose: "Fixture credential delivery",
      destination,
      fields: [{ name: "token" }],
    },
    agent,
  );
  expect(
    await callBroker("/v1/owner/secrets/pending", {}, owner),
  ).toMatchObject([{ id: request.id, canSave: true }]);
  const saved = await callBroker<{ ref: string }>(
    "/v1/owner/secrets/provide",
    {
      id: request.id,
      values: { token: value },
      retention: "saved",
      saveName: "fixture-token",
      password: PASSWORD,
    },
    owner,
  );
  const vaultFile = join(dir, "homelab.kdbx");
  const database = await openDatabase(vaultFile, passwordSource(PASSWORD));
  const entry = managedEntries(database.db).find((item) =>
    String(item.fields.get("Title")).startsWith("fixture-token ("),
  );
  if (!entry) throw new Error("The encrypted vault entry was not saved");
  expect(readFields(entry).token).toBe(value);
  expect((await readFile(vaultFile)).includes(Buffer.from(value))).toBe(false);
  expect(JSON.stringify(saved)).not.toContain(value);

  await callBroker("/v1/owner/vault/lock", {}, owner);
  const use = { ref: saved.ref, destination };
  await expect(callBroker("/v1/secret/use", use, agent)).rejects.toThrow(
    "Unlock the vault",
  );
  await signIn(daemon.endpoint);
  const delivered = await callBroker("/v1/secret/use", use, agent);
  expect(delivered).toMatchObject({ exitCode: 0 });
  expect(JSON.stringify(delivered)).not.toContain(value);
});
