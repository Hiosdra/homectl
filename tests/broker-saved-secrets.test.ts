import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths } from "../src/broker/paths";
import { createDatabase, passwordSource } from "../src/vault";

const PASSWORD = "disposable saved secret approval password";
const VALUE = "fixture-scope-secret-value";
let dir: string | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("explicit reuse survives restart only for the exact grant, and revocation survives restart", async () => {
  const work = await mkdtemp(join(tmpdir(), "hc-saved-reuse-"));
  dir = work;
  const inventoryPath = join(work, "inventory.yaml");
  const dbPath = join(work, "homelab.kdbx");
  await writeFile(
    inventoryPath,
    "version: 1\nmachines:\n  fixture:\n    description: Local fixture\n    transport: local\n    access: user\n",
  );
  const db = await createDatabase(dbPath, passwordSource(PASSWORD), {
    argon2: { iterations: 1, memory: 1024, parallelism: 1 },
  });
  await db.save();
  const received: string[] = [];
  const restart = async () => {
    await stop?.();
    stop = undefined;
    const daemon = await startDaemon({
      ...compatPaths(inventoryPath),
      mode: "compat",
      inventoryPath,
      sshConfigPath: join(work, "ssh_config"),
      keyAgent: {
        start: async () => undefined,
        add: async () => undefined,
        putSecret: async () => undefined,
        clear: async () => undefined,
      },
      executor: {
        run: async ({ stdin }) => {
          received.push(stdin ?? "");
          return { exitCode: 0, stdout: "fixture", stderr: "" };
        },
      },
    });
    stop = daemon.stop;
    const endpoint = daemon.endpoint;
    const { token } = await callBroker<{ token: string }>(
      "/v1/owner/login",
      { password: PASSWORD },
      { endpoint },
    );
    return {
      owner: <T>(path: string, input: Record<string, unknown> = {}) =>
        callBroker<T>(path, input, {
          endpoint,
          authorization: `Owner ${token}`,
        }),
      agent: <T>(
        client: string,
        path: string,
        input: Record<string, unknown>,
      ) =>
        callBroker<T>(path, input, {
          endpoint,
          authorization: `Bearer ${client}`,
        }),
    };
  };

  const client = await restart();
  const create = (id: string) =>
    client.owner<{ token: string }>("/v1/owner/clients/create", {
      id,
      name: id,
      hosts: ["fixture"],
      password: PASSWORD,
    });
  const { token: allowed } = await create("allowed-agent");
  const { token: other } = await create("other-agent");
  const request = {
    purpose: "Fixture credential delivery",
    destination: {
      kind: "ssh-stdin",
      host: "fixture",
      argv: ["fixture-receive"],
    },
    fields: [{ name: "token", kind: "token" }],
  };
  const path = "/v1/secret/request";
  const { token: observer } = await client.owner<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "observer",
      name: "Observer",
      hosts: ["fixture"],
      scopes: ["status:read"],
      password: PASSWORD,
    },
  );
  await expect(client.agent(observer, path, request)).rejects.toThrow(
    "Secret delivery is not granted",
  );
  const task = await client.agent<{ id: string }>(allowed, "/v1/task/open", {
    title: "Fixture task",
  });
  const scoped = await client.agent<{ id: string }>(allowed, path, {
    ...request,
    task: task.id,
  });
  const provided = await client.owner<{ ref: string }>(
    "/v1/owner/secrets/provide",
    {
      id: scoped.id,
      values: { token: VALUE },
      retention: "ephemeral",
      password: PASSWORD,
    },
  );
  await client.agent(allowed, "/v1/task/close", { id: task.id });
  await expect(
    client.agent(allowed, "/v1/secret/use", {
      ref: provided.ref,
      destination: request.destination,
      task: task.id,
    }),
  ).rejects.toThrow("The task is not open");
  expect(received).toEqual([]);
  const before = await client.agent<{ id: string; state: string }>(
    allowed,
    path,
    request,
  );
  expect(before.state).toBe("pending");
  await client.owner("/v1/owner/secrets/provide", {
    id: before.id,
    values: { token: VALUE },
    retention: "saved",
    saveName: "fixture-reuse",
    reuse: true,
    password: PASSWORD,
  });

  const after = await restart();
  const grants = await after.owner<{ id: string }[]>(
    "/v1/owner/secrets/saved-grants",
  );
  expect(grants).toMatchObject([
    {
      name: "fixture-reuse",
      client: "allowed-agent",
      fields: ["token"],
      destination: request.destination,
    },
  ]);
  expect(JSON.stringify(grants)).not.toContain(VALUE);
  const grant = grants[0];
  if (!grant) throw new Error("The vault did not persist the grant");
  const reuse = await after.agent<{ ref: string; state: string }>(
    allowed,
    path,
    request,
  );
  expect(reuse.state).toBe("provided");
  expect(await after.agent(allowed, path, request)).toMatchObject({
    ref: reuse.ref,
  });
  const deliver = () =>
    after.agent(allowed, "/v1/secret/use", {
      ref: reuse.ref,
      destination: request.destination,
    });
  expect(await deliver()).toMatchObject({ exitCode: 0 });
  expect(received).toEqual([VALUE]);
  expect(await after.agent(other, path, request)).toMatchObject({
    state: "pending",
  });
  expect(
    await after.agent(allowed, path, {
      ...request,
      destination: { ...request.destination, argv: ["different-destination"] },
    }),
  ).toMatchObject({ state: "pending" });
  expect(
    await after.agent(allowed, path, {
      ...request,
      fields: [{ name: "token", kind: "password" }],
    }),
  ).toMatchObject({ state: "pending" });

  const revoke = "/v1/owner/secrets/revoke-grant";
  await expect(after.owner(revoke, { id: grant.id })).rejects.toThrow(
    "Confirm with the owner password",
  );
  await after.owner(revoke, { id: grant.id, password: PASSWORD });
  await expect(deliver()).rejects.toThrow("not usable");
  const revoked = await restart();
  expect(await revoked.owner("/v1/owner/secrets/saved-grants")).toEqual([]);
  expect(await revoked.agent(allowed, path, request)).toMatchObject({
    state: "pending",
  });
  expect(received).toEqual([VALUE]);
}, 30_000);
