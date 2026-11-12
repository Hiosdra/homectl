import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Each device creates keys and state directories; Windows ACL setup is slow.
setDefaultTimeout(60_000);

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceKey,
  loadOrCreateDeviceKey,
} from "../src/control/device-key";
import { ControlPlane } from "../src/control/engine";
import { LEASE_MS, SKEW_MS } from "../src/control/lease";
import {
  createRecoveryKey,
  exportRecoveryBundle,
  restoreRecoveryBundle,
} from "../src/control/recovery";
import { ControlReplicator } from "../src/control/replicator";
import type { ProcessSpec, Runner } from "../src/types";
import { HomectlError } from "../src/types";

// Scenarios for the homectl 2.0 acceptance items that the single-feature tests do not
// combine: a lost peer rebuilt from its recovery bundle, and an owner's operation that
// stays with the owner until an operator takes it over. Devices are simulated in process
// on synthetic data; nothing is spawned and no host is contacted.

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const CHANGE = ["systemctl", "restart", "nginx"];
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Device {
  name: string;
  id: string;
  root: string;
  stateDirectory: string;
  inventoryPath: string;
  key: DeviceKey;
  plane: ControlPlane;
  rep: ControlReplicator;
  runs: ProcessSpec[];
}

async function openDevice(
  name: string,
  root: string,
  clock: { now: number },
  id: string | undefined,
): Promise<Device> {
  const inventoryPath = join(root, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const stateDirectory = join(root, "control-plane");
  const runs: ProcessSpec[] = [];
  const holder: { rep?: ControlReplicator } = {};
  const runner: Runner = async (spec) => {
    runs.push(spec);
    return { exitCode: 0, stdout: "demo\n", stderr: "" };
  };
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(root, "ssh_config"),
    stateDirectory,
    runner,
    clock: () => clock.now,
    fence: (opId) => holder.rep?.fence(opId),
    approverAuthorized: (approver, host) =>
      holder.rep?.approverAuthorized(approver, host) ?? false,
  });
  await plane.init();
  const key = await loadOrCreateDeviceKey(stateDirectory);
  const rep = await ControlReplicator.open({
    plane,
    stateDirectory,
    self: { id: id ?? randomUUID(), name, key },
    clock: () => clock.now,
  });
  holder.rep = rep;
  return {
    name,
    id: rep.self.id,
    root,
    stateDirectory,
    inventoryPath,
    key,
    plane,
    rep,
    runs,
  };
}

// Three devices, paired in every direction. Each has its own state directory.
async function network(
  names: string[],
  clock: { now: number },
): Promise<Record<string, Device>> {
  const devices: Record<string, Device> = {};
  for (const name of names) {
    const root = await mkdtemp(join(tmpdir(), "homectl-recovery-"));
    dirs.push(root);
    devices[name] = await openDevice(name, root, clock, undefined);
  }
  for (const a of Object.values(devices))
    for (const b of Object.values(devices))
      if (a !== b) await a.rep.addPeer(b.id, b.name, b.key.publicKey);
  return devices;
}

// Two passes let relayed records reach devices that are two hops away.
async function round(devices: Device[]): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    for (const d of devices) await d.rep.publish();
    for (const d of devices)
      for (const e of devices) if (d !== e) await d.rep.pullFrom(e.id, e.rep);
  }
}

async function planOn(d: Device, host: string): Promise<string> {
  const created = await d.plane.createClient({
    id: "codex-pc",
    name: "codex-pc",
    scopes: ["plan:create"],
    hosts: [host],
  });
  const client = await d.plane.authenticate(created.token);
  if (!client) throw new Error("token did not authenticate");
  const plan = (await d.plane.request(
    { kind: "client", client },
    { op: "plan", host, argv: CHANGE },
  )) as { operationId: string };
  return plan.operationId;
}

async function expectCode(
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

describe("a lost peer is rebuilt from its recovery bundle", () => {
  test("the restored device keeps its identity and history, and converges with the others", async () => {
    const clock = { now: 7_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await planOn(A, "agent-host");
    await round([A, B, C]);
    const originalId = B.id;
    const opsBefore = Object.keys(B.rep.replica.ops).sort();
    expect(opsBefore).toContain(operationId);

    // The recovery key is written once and kept outside the device's state directory.
    const keyPath = join(B.root, "owner-recovery.key");
    await createRecoveryKey(B.stateDirectory, keyPath);
    const bundlePath = join(B.root, "device-bundle.json");
    await exportRecoveryBundle({
      stateDirectory: B.stateDirectory,
      keyPath,
      outPath: bundlePath,
      clock: () => new Date(clock.now),
    });

    // The device is lost: its control state is gone. Its inventory file is not control state.
    await rm(B.stateDirectory, { recursive: true, force: true });
    await mkdir(B.stateDirectory);
    const restored = await restoreRecoveryBundle({
      stateDirectory: B.stateDirectory,
      keyPath,
      bundlePath,
    });
    expect(restored.restored.length).toBeGreaterThan(0);

    // Rebuild the device on the restored state, then let it sync again.
    const rebuilt = await openDevice("B", B.root, clock, originalId);
    const B2: Device = { ...rebuilt, runs: B.runs };
    expect(B2.id).toBe(originalId);
    expect(Object.keys(B2.rep.replica.ops).sort()).toEqual(opsBefore);

    await round([A, B2, C]);
    expect(B2.rep.ownerOf(operationId)).toBe(A.id);
    expect(A.rep.status().conflicts).toEqual([]);
    expect(B2.rep.status().conflicts).toEqual([]);
    expect(Object.keys(B2.rep.status().blocked)).toEqual([]);
    expect(Object.keys(C.rep.replica.ops).sort()).toEqual(
      Object.keys(B2.rep.replica.ops).sort(),
    );
  });

  test("a bundle opened with another key is refused, and the empty state directory stays empty", async () => {
    const clock = { now: 7_500_000 };
    const { A, B } = await network(["A", "B"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
    }));
    await planOn(A, "agent-host");
    await round([A, B]);
    const keyPath = join(B.root, "owner-recovery.key");
    const otherKeyPath = join(B.root, "other-recovery.key");
    await createRecoveryKey(B.stateDirectory, keyPath);
    await createRecoveryKey(B.stateDirectory, otherKeyPath);
    const bundlePath = join(B.root, "device-bundle.json");
    await exportRecoveryBundle({
      stateDirectory: B.stateDirectory,
      keyPath,
      outPath: bundlePath,
      clock: () => new Date(clock.now),
    });
    const fresh = join(B.root, "fresh-state");
    await mkdir(fresh);
    await expectCode(
      restoreRecoveryBundle({
        stateDirectory: fresh,
        keyPath: otherKeyPath,
        bundlePath,
      }),
      5,
      "does not match",
    );
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(fresh)).toEqual([]);
  });
});

describe("nothing moves an operation on its own", () => {
  test("after the owner stays silent past the window, the operation stays with it until an operator takes it over", async () => {
    const clock = { now: 8_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await planOn(A, "agent-host");
    await round([A, B, C]);

    // A goes silent. The takeover window opens, and B and C keep syncing without any operator.
    clock.now += LEASE_MS + SKEW_MS + 60_000;
    await round([B, C]);
    await round([B, C]);
    expect(B.rep.ownerOf(operationId)).toBe(A.id);
    expect(C.rep.ownerOf(operationId)).toBe(A.id);
    expect(B.runs.length + C.runs.length).toBe(0);

    // Only an explicit operator takeover on B moves it, and it stays pending there.
    await B.rep.takeover(operationId, "operator");
    await round([B, C]);
    expect(C.rep.ownerOf(operationId)).toBe(B.id);
    expect(B.runs.length + C.runs.length).toBe(0);
  });
});
