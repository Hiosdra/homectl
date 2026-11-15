import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../src/control/canonical";
import { loadOrCreateDeviceKey, signBytes } from "../src/control/device-key";
import { ControlPlane } from "../src/control/engine";
import type { ClientIdentity } from "../src/control/types";
import {
  HomectlError,
  type ProcessResult,
  type ProcessSpec,
} from "../src/types";

const INVENTORY = `version: 1
machines:
  pve-host:
    description: Synthetic Proxmox host
    transport: ssh
    access: full
    ssh_alias: pve-host
    address: 192.0.2.10
    user: ops
    auth:
      type: keepassxc
      entry: homectl-pve-host
      socket: /tmp/homectl-synthetic/agent.sock
      public_key: /tmp/homectl-synthetic/pve-host.pub
providers:
  pve-test:
    type: proxmox
    host: pve-host
    node: pve-test
    vmid_range: [9001, 9010]
    storages: [local-test]
`;

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("a correctly signed legacy restore plan is closed before the runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homectl-restore-legacy-"));
  directories.push(directory);
  const inventoryPath = join(directory, "inventory.yaml");
  const stateDirectory = join(directory, "control-plane");
  await writeFile(inventoryPath, INVENTORY);

  const runs: ProcessSpec[] = [];
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(directory, "ssh_config"),
    stateDirectory,
    runner: async (spec): Promise<ProcessResult> => {
      runs.push(spec);
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  });
  await plane.init();

  const restoreRegistration = await plane.createClient({
    id: "restore-client",
    name: "Restore client",
    scopes: ["plan:create", "proxmox:lxc:restore", "status:read"],
    hosts: ["pve-host"],
  });
  const approverRegistration = await plane.createClient({
    id: "hermes-admin",
    name: "Hermes Admin",
    scopes: ["approve:decide", "status:read"],
    hosts: ["pve-host"],
  });
  const restoreClient = (await plane.authenticate(
    restoreRegistration.token as string,
  )) as ClientIdentity;
  const approver = (await plane.authenticate(
    approverRegistration.token as string,
  )) as ClientIdentity;

  const planned = (await plane.request(
    { kind: "client", client: restoreClient },
    {
      op: "proxmox-plan",
      host: "pve-host",
      kind: "lxc",
      action: "start",
      vmid: 9006,
    },
  )) as { operationId: string; fingerprint: string };
  await plane.request(
    { kind: "client", client: approver },
    {
      op: "approve",
      operationId: planned.operationId,
      fingerprint: planned.fingerprint,
      decision: "approve",
    },
  );

  const statePath = join(stateDirectory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const record = state.operations[planned.operationId];
  record.plan.argv = [
    "sudo",
    "-n",
    "pct",
    "restore",
    "9006",
    "local-test:vzdump-lxc-9006.tar.zst",
  ];
  record.plan.impact = "Restore LXC 9006";
  record.plan.catalogueInput = {
    kind: "lxc",
    action: "restore",
    vmid: 9006,
    storage: "local-test",
  };
  record.fingerprint = fingerprint(record.plan);
  record.approval.fingerprint = record.fingerprint;
  record.planSignature = signBytes(
    (await loadOrCreateDeviceKey(stateDirectory)).privateKey,
    record.fingerprint,
  );
  await writeFile(statePath, JSON.stringify(state));

  let failure: unknown;
  try {
    await plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: planned.operationId },
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HomectlError);
  expect((failure as HomectlError).code).toBe(3);
  expect((failure as HomectlError).message).toContain(
    "Machine or command changed since approval",
  );
  expect(runs).toHaveLength(0);

  const closed = (await plane.listOperations({ all: true })).find(
    (operation) => operation.operationId === planned.operationId,
  );
  expect(closed?.state).toBe("failed");
  expect(closed?.reason).toBe("stale-plan");
});
