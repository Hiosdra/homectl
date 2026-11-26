// Central secret form across two real brokers over loopback (homelab #21 S1-S2,
// D8): a linked client's secret request is mirrored to the workspace server,
// the owner provides or declines it centrally with step-up, values NEVER touch
// workspace-server.json on disk, values are wiped on delivery or server vault
// lock, and the originating client remains the authority for single-decision
// arbitration and redacted delivery.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths, type Endpoint } from "../src/broker/paths";
import { saveInventory } from "../src/inventory";
import { createDatabase, passwordSource } from "../src/vault";

const SERVER_PW = "central server vault password";
const CLIENT_PW = "linked client vault password";
const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function makeBroker(options: {
  label: string;
  password: string;
  listenPort?: number;
  received?: string[];
}) {
  const dir = await mkdtemp(
    join(tmpdir(), `hc-central-secret-${options.label}-`),
  );
  dirs.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  const vaultPath = join(dir, "homelab.kdbx");
  await saveInventory(inventoryPath, {
    version: 1,
    session: { ttl: "24h", database: vaultPath },
    machines: {
      app: {
        description: "app host",
        transport: "ssh",
        access: "user",
        ssh_alias: "app",
        address: "192.0.2.20",
        user: "op",
        auth: {
          type: "keepassxc",
          inventory: inventoryPath,
          entry: "homectl-app",
          socket: join(dir, "agent.sock"),
          public_key: join(dir, "app.pub"),
        },
      },
    },
  });
  const db = await createDatabase(vaultPath, passwordSource(options.password), {
    argon2: SMALL,
  });
  await db.save();
  const paths = compatPaths(inventoryPath);
  const daemon = await startDaemon({
    mode: "compat",
    ...paths,
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    keyAgent: {
      start: async () => undefined,
      add: async () => undefined,
      putSecret: async () => undefined,
      clear: async () => undefined,
    },
    executor: {
      run: async ({ stdin }) => {
        if (stdin !== undefined) options.received?.push(stdin);
        return {
          exitCode: 0,
          stdout: `applied ${stdin ?? ""}`,
          stderr: "",
        };
      },
    },
    ...(options.listenPort === undefined
      ? {}
      : {
          workspace: {
            server: {
              listen: { hostname: "127.0.0.1", port: options.listenPort },
            },
          },
        }),
  });
  stops.push(daemon.stop);
  const signIn = async (endpoint: Endpoint = daemon.endpoint) => {
    const { token } = await callBroker<{ token: string }>(
      "/v1/owner/login",
      { password: options.password },
      { endpoint },
    );
    return { endpoint, authorization: `Owner ${token}` };
  };
  return { dir, state: paths.state, daemon, signIn };
}

async function pairClient(
  serverOwner: { endpoint: Endpoint; authorization: string },
  clientOwner: { endpoint: Endpoint; authorization: string },
  address: string,
  remoteApproval = true,
) {
  const invite = await callBroker<{ code: string }>(
    "/v1/owner/workspace/invite",
    { password: SERVER_PW },
    serverOwner,
  );
  await callBroker(
    "/v1/owner/workspace/join",
    {
      address,
      code: invite.code,
      remoteApproval,
      password: CLIENT_PW,
    },
    clientOwner,
  );
  const status = await callBroker<{ clientId: string }>(
    "/v1/owner/workspace/status",
    {},
    clientOwner,
  );
  return status.clientId;
}

test("central secret form delivers a secret over sync without persisting values on the server", async () => {
  const port = 34_000 + Math.floor(Math.random() * 10_000);
  const received: string[] = [];
  const server = await makeBroker({
    label: "server",
    password: SERVER_PW,
    listenPort: port,
  });
  const client = await makeBroker({
    label: "client",
    password: CLIENT_PW,
    received,
  });
  const serverOwner = await server.signIn();
  const clientOwner = await client.signIn();
  const clientId = await pairClient(
    serverOwner,
    clientOwner,
    `http://127.0.0.1:${port}`,
    true,
  );

  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex", name: "Codex", hosts: ["app"], password: CLIENT_PW },
    clientOwner,
  );
  const agent = {
    endpoint: client.daemon.endpoint,
    authorization: `Bearer ${token}`,
  };
  const destination = {
    kind: "ssh-stdin" as const,
    host: "app",
    argv: ["docker", "login", "--password-stdin"],
  };
  const requested = await callBroker<{ id: string; state: string }>(
    "/v1/secret/request",
    {
      purpose: "Registry token for deployment",
      destination,
      fields: [{ name: "token", kind: "token", label: "Registry token" }],
    },
    agent,
  );
  expect(requested.state).toBe("pending");

  // Client sync mirrors the pending secret request to the server.
  await callBroker("/v1/owner/workspace/sync-now", {}, clientOwner);
  const pending = await callBroker<
    {
      origin: string;
      id: string;
      purpose: { untrusted: string };
      canSave: boolean;
      intent: null | { status: string };
    }[]
  >("/v1/owner/workspace/secrets/pending", {}, serverOwner);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.origin).toBe(clientId);
  expect(pending[0]?.id).toBe(requested.id);
  expect(pending[0]?.purpose).toEqual({
    untrusted: "Registry token for deployment",
  });
  expect(pending[0]?.canSave).toBe(true);

  const secretValue = "ghp_super_secret_central_token_987654";
  // Wrong server password is refused.
  await expect(
    callBroker(
      "/v1/owner/workspace/secrets/provide",
      {
        client: clientId,
        id: requested.id,
        values: { token: secretValue },
        retention: "ephemeral",
        password: "wrong password",
      },
      serverOwner,
    ),
  ).rejects.toThrow("Confirm with the owner password");

  // Owner provides the secret on the server panel.
  const intent = await callBroker<{ id: string; status: string }>(
    "/v1/owner/workspace/secrets/provide",
    {
      client: clientId,
      id: requested.id,
      values: { token: secretValue },
      retention: "ephemeral",
      password: SERVER_PW,
    },
    serverOwner,
  );
  expect(intent.status).toBe("queued");

  // Plaintext secret value must NEVER appear in workspace-server.json on disk.
  const serverDisk = await readFile(
    join(server.state, "workspace-server.json"),
    "utf8",
  );
  expect(serverDisk).not.toContain(secretValue);

  // Client sync delivers the secret intent and applies it locally.
  await callBroker("/v1/owner/workspace/sync-now", {}, clientOwner);
  const status = await callBroker<{ state: string; ref?: string }>(
    "/v1/secret/status",
    { id: requested.id },
    agent,
  );
  expect(status.state).toBe("provided");
  expect(status.ref).toBeTruthy();

  // Agent uses the opaque ref; value is injected to stdin and redacted from output.
  const used = await callBroker<{ stdout: string; exitCode: number }>(
    "/v1/secret/use",
    { ref: status.ref, destination },
    agent,
  );
  expect(used.exitCode).toBe(0);
  expect(received).toEqual([secretValue]);
  expect(used.stdout).not.toContain(secretValue);

  // Server no longer shows the fulfilled secret as pending.
  const afterPending = await callBroker<unknown[]>(
    "/v1/owner/workspace/secrets/pending",
    {},
    serverOwner,
  );
  expect(afterPending).toEqual([]);
}, 30_000);

test("server vault lock wipes undelivered central secret values and origin decision wins over central", async () => {
  const port = 34_000 + Math.floor(Math.random() * 10_000);
  const server = await makeBroker({
    label: "server-lock",
    password: SERVER_PW,
    listenPort: port,
  });
  const client = await makeBroker({
    label: "client-lock",
    password: CLIENT_PW,
  });
  const serverOwner = await server.signIn();
  const clientOwner = await client.signIn();
  const clientId = await pairClient(
    serverOwner,
    clientOwner,
    `http://127.0.0.1:${port}`,
    true,
  );
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex", name: "Codex", hosts: ["app"], password: CLIENT_PW },
    clientOwner,
  );
  const agent = {
    endpoint: client.daemon.endpoint,
    authorization: `Bearer ${token}`,
  };
  const destination = {
    kind: "ssh-stdin" as const,
    host: "app",
    argv: ["docker", "login", "--password-stdin"],
  };
  const first = await callBroker<{ id: string }>(
    "/v1/secret/request",
    {
      purpose: "First secret",
      destination,
      fields: [{ name: "token", kind: "token" }],
    },
    agent,
  );
  await callBroker("/v1/owner/workspace/sync-now", {}, clientOwner);
  await callBroker(
    "/v1/owner/workspace/secrets/provide",
    {
      client: clientId,
      id: first.id,
      values: { token: "wiped-on-server-lock" },
      retention: "ephemeral",
      password: SERVER_PW,
    },
    serverOwner,
  );
  // Locking the server vault wipes the in-memory secret payload before sync.
  await callBroker("/v1/owner/vault/lock", {}, serverOwner);
  await Bun.sleep(50);
  await callBroker("/v1/owner/workspace/sync-now", {}, clientOwner);
  const afterLock = await callBroker<{ state: string }>(
    "/v1/secret/status",
    { id: first.id },
    agent,
  );
  expect(afterLock.state).toBe("pending");

  // Origin client declines locally first; a queued central provide is refused.
  const freshServerOwner = await server.signIn();
  await callBroker(
    "/v1/owner/workspace/secrets/provide",
    {
      client: clientId,
      id: first.id,
      values: { token: "too-late-central-value" },
      retention: "ephemeral",
      password: SERVER_PW,
    },
    freshServerOwner,
  );
  await callBroker("/v1/owner/secrets/decline", { id: first.id }, clientOwner);
  await callBroker("/v1/owner/workspace/sync-now", {}, clientOwner);
  const finalStatus = await callBroker<{ state: string }>(
    "/v1/secret/status",
    { id: first.id },
    agent,
  );
  expect(finalStatus.state).toBe("declined");
}, 30_000);
