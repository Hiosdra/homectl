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
import { LEASE_MS } from "../src/control/lease";

import {
  type AcceptBody,
  applyAccept,
  type Envelope,
  OFFER_TTL_MS,
  type OfferBody,
  sealRecord,
} from "../src/control/replicate";
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
    const dir = await mkdtemp(join(tmpdir(), "homectl-suspend-"));
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
      // Serve wires the replicated view in; the test planes do the same.
      replicaOverlay: (ids) =>
        holder.rep?.overlay(ids) ?? Promise.resolve({ notes: {}, remote: [] }),
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

async function clientOn(d: Device, id: string) {
  const created = await d.plane.createClient({
    id,
    name: id,
    scopes: ["plan:create"],
    hosts: ["agent-host"],
  });
  const identity = await d.plane.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  return identity;
}

async function plan(d: Device, argv: string[]): Promise<string> {
  const client = await clientOn(d, `codex-${randomUUID().slice(0, 6)}`);
  const made = (await d.plane.request(
    { kind: "client", client },
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

async function trio(start: number) {
  const clock = { now: start };
  const devices = await network(["A", "B", "C"], clock);
  return {
    clock,
    A: devices.A as Device,
    B: devices.B as Device,
    C: devices.C as Device,
  };
}

async function auditEvents(
  d: Device,
): Promise<{ event: string; reason?: string }[]> {
  return (await d.plane.auditEntries()).map((entry) => ({
    event: entry.event.event,
    reason: entry.event.reason,
  }));
}

describe("suspend a device from the lease", () => {
  test("an offline signing peer blocks execution; after suspend, execution works and is audited", async () => {
    const { clock, A, B, C } = await trio(13_000_000);
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);

    // B goes offline. A's lease needs B, so execution waits.
    clock.now += LEASE_MS + 1_000;
    await round([A, C]);
    await expectCode(execute(A, operationId), 3, "waiting for sync with B");

    // The operator suspends B from A's lease. Execution then works.
    await A.rep.suspendPeer(B.id, "offline for the weekend");
    const ran = (await execute(A, operationId)) as {
      operation: { state: string };
    };
    expect(ran.operation.state).toBe("succeeded");
    expect(
      A.rep.status().peers.find((p) => p.id === B.id)?.suspended,
    ).toMatchObject({
      by: "A",
    });
    const events = await auditEvents(A);
    expect(events.some((e) => e.event === "peer.suspended")).toBe(true);
  });

  test("the suspension replicates to a third peer, which shows who suspended whom", async () => {
    const { clock, A, B, C } = await trio(14_000_000);
    await round([A, B, C]);
    clock.now += LEASE_MS + 1_000;
    await A.rep.suspendPeer(B.id, "offline");
    await round([A, C]);
    expect(C.rep.replica.suspensions[`${A.id}|${B.id}`]?.active).toBe(true);
    expect(C.rep.status().suspensions).toEqual([
      expect.objectContaining({ by: "A", target: "B", reason: "offline" }),
    ]);
    // C never suspended anything: B still counts for C's own lease.
    expect(
      C.rep.status().peers.find((p) => p.id === B.id)?.suspended,
    ).toBeUndefined();
  });

  test("the peer comes back, syncs, is auto-resumed, and counts toward the lease again", async () => {
    const { clock, A, B, C } = await trio(15_000_000);
    await round([A, B, C]);
    clock.now += LEASE_MS + 1_000;
    await round([A, C]);
    await A.rep.suspendPeer(B.id, "offline");

    // B is back: a successful sync with it resumes the suspension.
    await round([A, B, C]);
    expect(A.rep.isSuspendedBySelf(B.id)).toBe(false);
    const events = await auditEvents(A);
    expect(
      events.some(
        (e) => e.event === "peer.resumed" && e.reason?.includes("synced"),
      ),
    ).toBe(true);

    // B counts again: once it goes silent, A's lease waits for it.
    clock.now += LEASE_MS + 1_000;
    await round([A, C]);
    const second = await plan(A, INSPECT);
    await expectCode(execute(A, second), 3, "waiting for sync with B");
  });

  test("a suspended peer must sync before it executes anything: its own lease enforces that", async () => {
    const { clock, A, B, C } = await trio(16_000_000);
    const bOwn = await plan(B, INSPECT);
    await round([A, B, C]);
    await A.rep.suspendPeer(B.id, "offline");
    // B was offline long enough that its lease with A and C has lapsed.
    clock.now += LEASE_MS + 1_000;
    await expectCode(execute(B, bOwn), 3, "lease expired");
    expect(B.runs.length).toBe(0);
    // After it syncs with its peers, B may execute again.
    await round([A, B, C]);
    const ran = (await execute(B, bOwn)) as { operation: { state: string } };
    expect(ran.operation.state).toBe("succeeded");
  });

  test("a suspended peer cannot run an operation that this device owns", async () => {
    const { A, B, C } = await trio(17_000_000);
    const aOwn = await plan(A, INSPECT);
    await round([A, B, C]);
    await A.rep.suspendPeer(B.id, "offline");
    await expectCode(execute(B, aOwn), 3, "runs on A");
    expect(B.runs.length).toBe(0);
  });

  test("a handoff to a suspended peer is refused until it resumes", async () => {
    const { A, B, C } = await trio(18_000_000);
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    await A.rep.suspendPeer(B.id, "offline");
    await expectCode(
      A.rep.offerHandoff(operationId, "B"),
      3,
      "suspended from this device's lease",
    );
    await A.rep.resumePeer(B.id);
    const offer = await A.rep.offerHandoff(operationId, "B");
    expect(offer.to).toBe(B.id);
  });

  test("suspending twice, or resuming a peer that is not suspended, is refused", async () => {
    const { A, B, C } = await trio(19_000_000);
    await round([A, B, C]);
    await A.rep.suspendPeer(B.id, "offline");
    await expectCode(A.rep.suspendPeer(B.id), 2, "already suspended");
    await A.rep.resumePeer(B.id);
    await expectCode(A.rep.resumePeer(B.id), 2, "not suspended");
  });
});

describe("handoff offers expire", () => {
  test("an expired offer no longer blocks the owner, and a late accept is rejected", async () => {
    const { clock, A, B, C } = await trio(20_000_000);
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    await A.rep.offerHandoff(operationId, "B");
    await round([A, B, C]);
    await expectCode(execute(A, operationId), 3, "Handoff offered to B");

    // The offer is open until it expires; after that the owner may run again.
    clock.now += OFFER_TTL_MS + 1_000;
    // The owner keeps syncing, so only the offer's expiry decides the fence.
    await round([A, B, C]);
    const listed = (await A.plane.listOperations({ all: true })).find(
      (op) => op.operationId === operationId,
    );
    expect(listed?.offerTo).toBe("B");
    expect(listed?.offerExpires).toBeDefined();
    // The fence is what the offer expiry controls: once expired, nothing refuses
    // the owner. (The plan itself also lives 15 minutes, so the operation is not
    // executed here; the fence assertion is the contract.)
    expect(A.rep.fence(operationId)).toBeUndefined();

    // The receiver's own clock check refuses the accept.
    await expectCode(B.rep.acceptOffer(operationId), 3, "expired");

    // A signed accept dated after expiry is rejected on every device.
    const offer = Object.values(A.rep.replica.offers).find(
      (o) => o.opId === operationId,
    ) as OfferBody;
    const late: AcceptBody = {
      kind: "accept",
      offerId: offer.offerId,
      opId: operationId,
      fromOwner: A.id,
      toOwner: B.id,
      epoch: offer.epoch,
      at: new Date(clock.now).toISOString(),
    };
    const outcome = applyAccept(
      A.rep.replica,
      sealRecord(B, late) as Envelope<AcceptBody>,
      {
        [A.id]: A.key.publicKey,
        [B.id]: B.key.publicKey,
        [C.id]: C.key.publicKey,
      },
    );
    expect(outcome).toBe("rejected");
    expect(A.rep.ownerOf(operationId)).toBe(A.id);
  });

  test("after expiry the owner can offer again: the expired offer is cancelled first", async () => {
    const { clock, A, B, C } = await trio(21_000_000);
    const operationId = await plan(A, INSPECT);
    await round([A, B, C]);
    const first = await A.rep.offerHandoff(operationId, "B");
    clock.now += OFFER_TTL_MS + 1_000;
    const second = await A.rep.offerHandoff(operationId, "C");
    expect(second.offerId).not.toBe(first.offerId);
    expect(A.rep.replica.offerStatus[first.offerId]).toBe("cancelled");
    expect(A.rep.replica.offerStatus[second.offerId]).toBe("open");
  });
});
