import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Each device creates keys and state directories; Windows ACL setup is slow.
setDefaultTimeout(60_000);

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceKey,
  loadOrCreateDeviceKey,
} from "../src/control/device-key";
import { ControlPlane } from "../src/control/engine";
import { LEASE_MS, SKEW_MS } from "../src/control/lease";
import { ControlReplicator } from "../src/control/replicator";
import type { ProcessSpec, Runner } from "../src/types";
import { HomectlError } from "../src/types";

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const CHANGE = ["systemctl", "restart", "nginx"];
const INSPECT = ["hostname"];
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Device {
  name: string;
  id: string;
  key: DeviceKey;
  plane: ControlPlane;
  rep: ControlReplicator;
  runs: ProcessSpec[];
}

// Devices share one simulated clock; nothing is spawned (fake runner).
async function network(
  names: string[],
  clock: { now: number },
): Promise<Record<string, Device>> {
  const devices: Record<string, Device> = {};
  for (const name of names) {
    const dir = await mkdtemp(join(tmpdir(), "homectl-handoff-"));
    dirs.push(dir);
    const inventoryPath = join(dir, "inventory.yaml");
    await writeFile(inventoryPath, INVENTORY);
    const stateDirectory = join(dir, "control-plane");
    const runs: ProcessSpec[] = [];
    const holder: { rep?: ControlReplicator } = {};
    const runner: Runner = async (spec) => {
      runs.push(spec);
      return { exitCode: 0, stdout: "demo\n", stderr: "" };
    };
    const plane = new ControlPlane({
      inventoryPath,
      configPath: join(dir, "ssh_config"),
      stateDirectory,
      runner,
      clock: () => clock.now,
      fence: (id) => holder.rep?.fence(id),
      approverAuthorized: (id, host) =>
        holder.rep?.approverAuthorized(id, host) ?? false,
    });
    await plane.init();
    const key = await loadOrCreateDeviceKey(stateDirectory);
    const rep = await ControlReplicator.open({
      plane,
      stateDirectory,
      self: { id: randomUUID(), name, key },
      clock: () => clock.now,
    });
    holder.rep = rep;
    devices[name] = { name, id: rep.self.id, key, plane, rep, runs };
  }
  // Pairing exchanges names and signing keys (ADR-0002 decision 1).
  for (const a of Object.values(devices))
    for (const b of Object.values(devices))
      if (a !== b) await a.rep.addPeer(b.id, b.name, b.key.publicKey);
  return devices;
}

async function round(devices: Device[]): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    for (const d of devices) await d.rep.publish();
    for (const d of devices)
      for (const e of devices) if (d !== e) await d.rep.pullFrom(e.id, e.rep);
  }
}

async function clientOn(d: Device, id: string, scopes: string[]) {
  const created = await d.plane.createClient({
    id,
    name: id,
    scopes,
    hosts: ["agent-host"],
  });
  const identity = await d.plane.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  return identity;
}

async function plan(d: Device, argv: string[]): Promise<string> {
  const codex = await clientOn(d, `codex-${randomUUID().slice(0, 6)}`, [
    "plan:create",
  ]);
  const made = (await d.plane.request(
    { kind: "client", client: codex },
    { op: "plan", host: "agent-host", argv },
  )) as { operationId: string };
  return made.operationId;
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

function execute(d: Device, operationId: string) {
  return d.plane.request(
    { kind: "local-operator" },
    { op: "execute", operationId },
  );
}

// Two takeovers at the same epoch, after the owner went silent.
async function conflicted(clockStart: number) {
  const clock = { now: clockStart };
  const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
    A: d.A as Device,
    B: d.B as Device,
    C: d.C as Device,
  }));
  const operationId = await plan(A, CHANGE);
  await round([A, B, C]);
  clock.now += LEASE_MS + SKEW_MS + 1_000;
  await B.rep.takeover(operationId, "operator");
  await C.rep.takeover(operationId, "operator");
  await round([B, C]);
  return { clock, A, B, C, operationId };
}

describe("cooperative handoff: offer, accept, cancel", () => {
  test("offer then accept: the owner stops running the operation and the receiver owns it pending", async () => {
    const clock = { now: 8_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);

    await A.rep.offerHandoff(operationId, "B");
    // From the offer on, the owner refuses to run the operation here.
    await expectCode(execute(A, operationId), 3, "Handoff offered to B");
    await round([A, B, C]);
    await expectCode(execute(A, operationId), 3, "Handoff offered to B");

    await B.rep.acceptOffer(operationId);
    await round([A, B, C]);
    expect(A.rep.ownerOf(operationId)).toBe(B.id);
    expect(C.rep.ownerOf(operationId)).toBe(B.id);
    await expectCode(execute(A, operationId), 3, "now belongs to B");
    expect(A.runs.length).toBe(0);

    // The receiver holds the operation as pending: a fresh approval is needed there.
    const onB = (await B.plane.listOperations({ all: true })).find(
      (op) => op.operationId === operationId,
    );
    expect(onB?.state).toBe("pending");
    expect(A.rep.openOfferBy(operationId)).toBeUndefined();
  });

  test("an offer is cancelled before acceptance; the receiver can no longer accept it", async () => {
    const clock = { now: 8_500_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    await A.rep.offerHandoff(operationId, "B");
    await round([A, B, C]);
    await A.rep.cancelOffer(operationId);
    await round([A, B, C]);

    // The receiver has seen the cancel, so its accept has nothing to accept.
    await expectCode(B.rep.acceptOffer(operationId), 2);
    expect(A.rep.ownerOf(operationId)).toBe(A.id);
    expect(B.rep.ownerOf(operationId)).toBe(A.id);
    // The owner runs again after the cancel (inspection needs no approval).
    const ran = (await execute(A, operationId)) as {
      operation: { state: string };
    };
    expect(ran.operation.state).toBe("succeeded");
  });

  test("a stale accept that arrives after the owner cancelled is rejected by the owner", async () => {
    const clock = { now: 8_700_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    await A.rep.offerHandoff(operationId, "B");
    await round([A, B, C]);
    // B accepts before it has seen the cancel; A cancels before it has seen the accept.
    await B.rep.acceptOffer(operationId);
    await A.rep.cancelOffer(operationId);
    await round([A, B, C]);
    // The owner's replica keeps the cancel: the late accept is rejected there.
    expect(A.rep.ownerOf(operationId)).toBe(A.id);
    expect(A.rep.replica.handoffs[operationId]?.[2]).toBeUndefined();
    // Residual race, recorded in the design doc: B applied its accept locally
    // before it saw the cancel, so its own view can differ until the owner's
    // refusal is resolved by an operator. The test pins the owner-side rule only.
  });

  test("the owner cannot offer while an offer is open, or offer to a legacy device", async () => {
    const clock = { now: 8_900_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    await A.rep.offerHandoff(operationId, "B");
    await expectCode(
      A.rep.offerHandoff(operationId, "C"),
      3,
      "already offered",
    );
    await A.rep.cancelOffer(operationId);
    await A.rep.addPeer(C.id, "C", undefined);
    await expectCode(
      A.rep.offerHandoff(operationId, "C"),
      3,
      "cannot take a handoff",
    );
    // A non-owner cannot offer at all.
    await expectCode(
      B.rep.offerHandoff(operationId, "C"),
      3,
      "Only the current owner",
    );
  });
});

describe("legacy peers are excluded from the lease", () => {
  test("a legacy peer that stays silent does not block execution; it is shown as excluded", async () => {
    const clock = { now: 9_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    // B is paired before signing keys existed: it cannot sign, so it is excluded.
    await A.rep.addPeer(B.id, "B", undefined);
    clock.now += LEASE_MS + 1_000;
    await round([A, C]);
    const ran = (await execute(A, operationId)) as {
      operation: { state: string };
    };
    expect(ran.operation.state).toBe("succeeded");

    const row = A.rep.status().peers.find((p) => p.id === B.id);
    expect(row?.excluded).toBe(true);
    expect(row?.lastSync).toBeUndefined();
    expect(row?.leaseOk).toBe(false);
  });

  test("a signing peer that stays silent still blocks execution", async () => {
    const clock = { now: 9_100_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    await A.rep.addPeer(B.id, "B", undefined);
    clock.now += LEASE_MS + 1_000;
    await round([A, B]); // C silent with a signing key
    await expectCode(execute(A, operationId), 3, "waiting for sync with C");
  });
});

describe("conflict resolution", () => {
  test("a proposal applies only once the named winner accepts, and the op then has one owner", async () => {
    const { A, B, C, operationId } = await conflicted(10_000_000);
    expect(B.rep.status().conflicts.map((c) => c.epoch)).toEqual([2]);

    await B.rep.resolveConflict(operationId, "C");
    await round([A, B, C]);
    // Not yet: the named winner has not agreed. The conflict stays visible.
    expect(B.rep.ownerOf(operationId)).toBeUndefined();
    expect(B.rep.status().conflicts.length).toBe(1);
    expect(B.rep.status().resolutions.length).toBe(1);
    expect(C.rep.resolutionWaitingFor(operationId)).toBe(true);
    await expectCode(execute(B, operationId), 3, "not established");

    await C.rep.acceptResolution(operationId);
    await round([A, B, C]);
    expect(A.rep.ownerOf(operationId)).toBe(C.id);
    expect(B.rep.ownerOf(operationId)).toBe(C.id);
    expect(B.rep.status().conflicts).toEqual([]);
    expect(B.rep.status().resolutions).toEqual([]);
    await expectCode(execute(B, operationId), 3, "now belongs to C");
  });

  test("a proposal from a device outside the conflict is refused", async () => {
    const clock = { now: 11_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, CHANGE);
    await round([A, B, C]);
    clock.now += LEASE_MS + SKEW_MS + 1_000;
    await B.rep.takeover(operationId, "operator");
    await round([A, B]); // only B takes over: no conflict at all
    await expectCode(
      A.rep.resolveConflict(operationId, "B"),
      3,
      "No ownership conflict",
    );
  });

  test("a second, different resolution at the same epoch is again a conflict", async () => {
    const { A, B, C, operationId } = await conflicted(12_000_000);
    await B.rep.resolveConflict(operationId, "B");
    await C.rep.resolveConflict(operationId, "C");
    await B.rep.acceptResolution(operationId);
    await C.rep.acceptResolution(operationId);
    await round([A, B, C]);
    // Two winners at epoch 3: visible as a conflict with both candidates.
    const conflict = B.rep.status().conflicts;
    expect(conflict).toEqual([
      { opId: operationId, epoch: 3, candidates: [B.id, C.id].sort() },
    ]);
    expect(A.rep.ownerOf(operationId)).toBeUndefined();
    await expectCode(execute(A, operationId), 3);
    await expectCode(execute(B, operationId), 3);
    await expectCode(execute(C, operationId), 3);
    expect(A.runs.length + B.runs.length + C.runs.length).toBe(0);
  });
});

describe("offer lifetime and finished operations", () => {
  test("a plain offer lasts five minutes", async () => {
    const clock = { now: 31_500_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    const offer = await A.rep.offerHandoff(operationId, "B");
    const stored = A.rep.replica.offers[offer.offerId];
    expect(stored).toBeDefined();
    expect(
      Date.parse(stored?.expiresAt ?? "") - Date.parse(stored?.at ?? ""),
    ).toBe(5 * 60_000);
  });

  test("an offer never outlives the plan: expiry is the earlier of five minutes and the plan's expiry", async () => {
    const clock = { now: 31_600_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    const planExpiry = Date.parse(
      (await A.plane.showOperation(operationId)).expiresAt,
    );
    await round([A, B, C]);
    // Twelve minutes in: the plan ends at minute 15, before now + 5 (minute 17).
    clock.now += 12 * 60_000;
    await round([A, B, C]);
    const offer = await A.rep.offerHandoff(operationId, "B");
    const stored = A.rep.replica.offers[offer.offerId];
    expect(Date.parse(stored?.expiresAt ?? "")).toBe(planExpiry);
    expect(Date.parse(stored?.expiresAt ?? "")).toBeLessThan(
      clock.now + 5 * 60_000,
    );
    // Replicated: a device that pulls the offer sees the same clamped expiry.
    await round([A, B, C]);
    expect(C.rep.replica.offers[offer.offerId]?.expiresAt).toBe(
      stored?.expiresAt,
    );
  });

  // The window is narrow but real. The owner may run only within the lease
  // (120 s) of its last sync, so the accept must be signed after A's last sync,
  // before the offer expires, and A must run after the expiry but still inside
  // that lease. The test follows exactly that timeline.
  test("an accept signed before expiry, arriving after the owner executed, is rejected and the finished state never regresses", async () => {
    const clock = { now: 31_700_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    const offer = await A.rep.offerHandoff(operationId, "B");

    // A syncs four minutes in. B accepts just before the offer expires; the
    // accept is in B's log and has not reached A or C.
    clock.now += 4 * 60_000;
    await round([A, B, C]);
    await round([A, C]);
    clock.now += 30_000;
    await B.rep.acceptOffer(operationId);
    // A runs after the expiry, inside its lease (last sync 90 s ago).
    clock.now += 90_000;
    const ran = (await execute(A, operationId)) as {
      operation: { state: string };
    };
    expect(ran.operation.state).toBe("succeeded");

    // C learns the finished state from A's log, before the late accept.
    await round([A, C]);
    expect(C.rep.replica.ops[operationId]?.state).toBe("succeeded");

    // The late accept reaches A and C. Both refuse it.
    await round([A, B, C]);
    expect(A.rep.ownerOf(operationId)).toBe(A.id);
    expect(C.rep.ownerOf(operationId)).toBe(A.id);
    expect(A.rep.replica.handoffs[operationId]?.[2]).toBeUndefined();
    expect(C.rep.replica.handoffs[operationId]?.[2]).toBeUndefined();
    expect(A.rep.replica.offerStatus[offer.offerId]).toBe("open");
    // The finished state never goes back, on the owner or on the third device.
    expect(A.rep.replica.ops[operationId]?.state).toBe("succeeded");
    expect(C.rep.replica.ops[operationId]?.state).toBe("succeeded");
    await round([A, B, C]);
    expect(C.rep.replica.ops[operationId]?.state).toBe("succeeded");
    expect(A.rep.replica.ops[operationId]?.state).toBe("succeeded");
  });
});
