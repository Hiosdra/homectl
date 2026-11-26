import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { compatPaths } from "../src/broker/paths";
import type { OperationView } from "../src/broker/types";
import { createDatabase, passwordSource } from "../src/vault";
import {
  FakeHost,
  unquoteSshCommand,
  writeTargets,
} from "./hostperm-fake-remote";

const PASSWORD = "disposable native grant password";
const dropIn = "/etc/sudoers.d/homectl-oskar";
let dir: string | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("assistant can queue a managed sudo grant but only the owner can confirm the exact live preview", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "hc-assistant-host-grant-"));
  dir = fixture;
  const inventoryPath = join(fixture, "inventory.yaml");
  const vaultPath = join(fixture, "homelab.kdbx");
  const inventory = [
    "version: 1",
    "session:",
    '  ttl: "24h"',
    `  database: ${JSON.stringify(vaultPath)}`,
    "machines:",
    "  lab:",
    "    description: Simulated Linux host",
    "    transport: ssh",
    "    ssh_alias: lab",
    "    address: 192.0.2.10",
    "    user: oskar",
    "    access: sudo-approved",
    "    sudo_allow:",
    "      - [/usr/bin/systemctl, restart, fixture.service]",
    "    auth:",
    "      type: keepassxc",
    "      entry: homectl-lab",
    `      socket: ${JSON.stringify(join(fixture, "agent.sock"))}`,
    `      public_key: ${JSON.stringify(join(fixture, "lab.pub"))}`,
  ].join("\n");
  await writeFile(inventoryPath, inventory);
  await writeFile(
    join(fixture, "known_hosts"),
    "192.0.2.10 ssh-ed25519 YQ==\n",
  );
  const database = await createDatabase(vaultPath, passwordSource(PASSWORD), {
    argon2: { memory: 1024, iterations: 1, parallelism: 1 },
  });
  await database.save();
  const host = new FakeHost();
  const daemon = await startDaemon({
    ...compatPaths(inventoryPath),
    mode: "compat",
    inventoryPath,
    sshConfigPath: join(fixture, "ssh_config"),
    keyAgent: {
      start: async () => undefined,
      add: async () => undefined,
      putSecret: async () => undefined,
      clear: async () => undefined,
    },
    machineRunner: async (spec) => {
      expect(spec.argv).toContain("StrictHostKeyChecking=yes");
      return host.exec(unquoteSshCommand(spec.argv.at(-1) ?? ""), {
        stdin: spec.stdin,
      });
    },
  });
  stop = daemon.stop;
  const endpoint = daemon.endpoint;
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint },
  );
  const owner = { endpoint, authorization: `Owner ${token}` };
  const { token: agentToken } = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    {
      id: "fixture-agent",
      name: "Fixture agent",
      hosts: ["lab"],
      password: PASSWORD,
    },
    owner,
  );
  const agent = { endpoint, authorization: `Bearer ${agentToken}` };
  const submit = () =>
    callBroker<OperationView>(
      "/v1/setup/request/sudo-grant",
      { name: "lab" },
      agent,
    );
  const preview = () =>
    callBroker<{ grant: { diff: string; fingerprint: string } }>(
      "/v1/owner/hosts/preview-grant",
      { host: "lab", password: PASSWORD },
      owner,
    );
  const approve = (op: OperationView, grantFingerprint?: string) =>
    callBroker(
      "/v1/owner/decide",
      {
        operationId: op.id,
        fingerprint: op.fingerprint,
        decision: "approve-once",
        password: PASSWORD,
        grantFingerprint,
      },
      owner,
    );
  const wait = (op: OperationView) =>
    callBroker<OperationView>(
      "/v1/wait",
      { id: op.id, timeoutMs: 5000 },
      agent,
    );
  const writes = () => host.log.flatMap((entry) => writeTargets(entry.argv));

  const first = await submit();
  expect(first.state).toBe("awaiting-approval");
  expect(host.log).toEqual([]);
  await expect(
    callBroker("/v1/owner/hosts/preview-grant", { host: "lab" }, agent),
  ).rejects.toThrow();
  await expect(approve(first)).rejects.toThrow("Preview the exact sudo grant");
  expect(host.log).toEqual([]);
  const { grant: before } = await preview();
  expect(before.diff).toContain("/usr/bin/systemctl restart fixture.service");
  expect(writes()).toEqual([]);

  host.put(dropIn, "# unmanaged fixture content\n", { mode: "0440" });
  await approve(first, before.fingerprint);
  expect(await wait(first)).toMatchObject({ state: "failed" });
  expect(host.text(dropIn)).toBe("# unmanaged fixture content\n");
  expect(writes()).toEqual([]);

  host.files.delete(dropIn);
  const second = await submit();
  const { grant: current } = await preview();
  await approve(second, current.fingerprint);
  expect(await wait(second)).toMatchObject({ state: "succeeded" });
  expect(host.text(dropIn)).toContain(
    "/usr/bin/systemctl restart fixture.service",
  );
  expect(writes().length).toBeGreaterThan(0);
  expect(
    writes().every((path) => /^\/etc\/sudoers\.d\/\.?homectl-oskar/.test(path)),
  ).toBe(true);
}, 30_000);
