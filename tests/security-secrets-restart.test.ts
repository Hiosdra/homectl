// A daemon restart over the same state directory (homelab #21 §5: "drop
// ephemeral values on lock/restart"). The provided value lives only in memory,
// so after the restart its reference and request are gone and cannot be used.
// Owner sessions do not survive the restart either. Canary values only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import type { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";

const PASSWORD = "owner restart pass";
const CANARY = "CANARY-restart-8a21-do-not-leak";
const destination = {
  kind: "ssh-stdin",
  host: "pc",
  argv: ["docker", "login", "--password-stdin"],
};

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
let dir: string;
let live: Daemon[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-restart-"));
  await writeFile(
    join(dir, "inventory.yaml"),
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n",
  );
});
afterEach(async () => {
  for (const daemon of live.splice(0)) await daemon.stop().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function boot(ran: string[][]): Promise<Daemon> {
  const inventoryPath = join(dir, "inventory.yaml");
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    executor: {
      run: async ({ argv }) => {
        ran.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });
  live.push(daemon);
  return daemon;
}

async function stop(daemon: Daemon) {
  live = live.filter((item) => item !== daemon);
  await daemon.stop();
}

test("a restart drops the provided value: its reference and request are refused, while the agent's registration persists", async () => {
  const ran: string[][] = [];
  const first = await boot(ran);
  await (first.verifier as FileVerifier).set(PASSWORD);
  const asOwner = {
    endpoint: first.endpoint,
    authorization: `Owner ${
      (
        await callBroker<{ token: string }>(
          "/v1/owner/login",
          { password: PASSWORD },
          { endpoint: first.endpoint },
        )
      ).token
    }`,
  };
  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex-pc", name: "Codex", hosts: ["pc"], password: PASSWORD },
    asOwner,
  );
  const agent = {
    endpoint: first.endpoint,
    authorization: `Bearer ${created.token}`,
  };
  const request = await callBroker<{ id: string }>(
    "/v1/secret/request",
    { purpose: "registry login", destination, fields: [{ name: "token" }] },
    agent,
  );
  await callBroker(
    "/v1/owner/secrets/provide",
    {
      id: request.id,
      values: { token: CANARY },
      retention: "ephemeral",
      password: PASSWORD,
    },
    asOwner,
  );
  const status = await callBroker<{ ref: string }>(
    "/v1/secret/status",
    { id: request.id },
    agent,
  );
  await callBroker("/v1/secret/use", { ref: status.ref, destination }, agent);
  expect(ran).toEqual([destination.argv]);
  await stop(first);

  const second = await boot(ran);
  const after = {
    endpoint: second.endpoint,
    authorization: `Bearer ${created.token}`,
  };
  // The agent's token is persisted, so the refusals below come from the
  // dropped memory, not from authentication.
  expect((await callBroker<{ id: string }>("/v1/whoami", {}, after)).id).toBe(
    "codex-pc",
  );
  await expect(
    callBroker("/v1/secret/use", { ref: status.ref, destination }, after),
  ).rejects.toThrow("secret reference is not usable");
  await expect(
    callBroker("/v1/secret/status", { id: request.id }, after),
  ).rejects.toThrow("secret request not found");
  expect(ran).toEqual([destination.argv]);
  // After the restart the owner's history is empty: nothing was carried over.
  const owner = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint: second.endpoint },
  );
  expect(
    await callBroker<unknown[]>(
      "/v1/owner/secrets/history",
      {},
      { endpoint: second.endpoint, authorization: `Owner ${owner.token}` },
    ),
  ).toEqual([]);
});

test("an owner session from before the restart is refused; a fresh sign-in works", async () => {
  const ran: string[][] = [];
  const first = await boot(ran);
  await (first.verifier as FileVerifier).set(PASSWORD);
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint: first.endpoint },
  );
  expect(
    (
      await callBroker<unknown[]>(
        "/v1/owner/pending",
        {},
        { endpoint: first.endpoint, authorization: `Owner ${token}` },
      )
    ).length,
  ).toBe(0);
  await stop(first);

  const second = await boot(ran);
  await expect(
    callBroker(
      "/v1/owner/pending",
      {},
      { endpoint: second.endpoint, authorization: `Owner ${token}` },
    ),
  ).rejects.toThrow("Owner sign-in required");
  const fresh = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint: second.endpoint },
  );
  expect(fresh.token).not.toBe(token);
  expect(
    await callBroker<unknown[]>(
      "/v1/owner/pending",
      {},
      { endpoint: second.endpoint, authorization: `Owner ${fresh.token}` },
    ),
  ).toEqual([]);
});
