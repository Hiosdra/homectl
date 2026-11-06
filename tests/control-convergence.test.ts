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

// Three devices share one simulated clock. Each has its own inventory,
// state directory, device key and fake runner: nothing is spawned.
async function network(
  names: string[],
  clock: { now: number },
): Promise<Record<string, Device>> {
  const devices: Record<string, Device> = {};
  for (const name of names) {
    const dir = await mkdtemp(join(tmpdir(), "homectl-converge-"));
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

// One full round: every device publishes, then pulls from every other device.
// Two passes let relayed records reach devices that are two hops away.
async function round(devices: Device[]): Promise<void> {
  // Publishing can follow an inbox decision, and pulls can relay what another
  // device published, so repeat until nothing changes in a pass.
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

describe("convergence and approval across three peers", () => {
  test("a plan replicates, a remote approval reaches the owner, and the result converges", async () => {
    const clock = { now: 1_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const codex = await clientOn(A, "codex-pc", ["plan:create", "status:read"]);
    const hermes = await clientOn(B, "hermes-admin", [
      "approve:decide",
      "status:read",
    ]);
    const plan = (await A.plane.request(
      { kind: "client", client: codex },
      { op: "plan", host: "agent-host", argv: CHANGE },
    )) as { operationId: string; fingerprint: string };
    await round([A, B, C]);
    expect(B.rep.replica.ops[plan.operationId]?.state).toBe("pending");
    expect(C.rep.replica.ops[plan.operationId]?.owner).toBe(A.id);

    await B.rep.decide(hermes, plan.operationId, plan.fingerprint, "approve");
    await round([A, B, C]);
    expect(B.rep.replica.ops[plan.operationId]?.state).toBe("approved");
    expect(C.rep.replica.ops[plan.operationId]?.state).toBe("approved");

    const ran = (await A.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: plan.operationId },
    )) as { operation: { state: string } };
    expect(ran.operation.state).toBe("succeeded");
    await round([A, B, C]);
    expect(B.rep.replica.ops[plan.operationId]?.state).toBe("succeeded");
    expect(C.rep.replica.ops[plan.operationId]?.state).toBe("succeeded");
    // Only the owner ever spawned a process.
    expect([A.runs.length, B.runs.length, C.runs.length]).toEqual([1, 0, 0]);

    // Replay: the approval envelope is delivered again, and the operation cannot run twice.
    const replayed = B.rep.serve({ known: {} }).origins[B.id];
    const decisionEntry = replayed?.entries.find(
      (e) =>
        (e.envelope as { body: { kind: string } }).body.kind === "decision",
    );
    expect(decisionEntry).toBeDefined();
    const head = replayed?.head ?? { seq: 0, hash: "" };
    await A.rep.receive(
      { origins: { [B.id]: { head, entries: [decisionEntry as never] } } },
      B.id,
    );
    await A.rep.pullFrom(B.id, B.rep);
    await expectCode(
      A.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
    );
    expect(A.runs.length).toBe(1);
    expect(A.rep.replica.ops[plan.operationId]?.state).toBe("succeeded");
    expect(A.rep.status().blocked).toEqual({});
  });

  test("a revoked approver's decision is not applied on the owner", async () => {
    const clock = { now: 2_000_000 };
    const { A, B } = await network(["A", "B"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
    }));
    const codex = await clientOn(A, "codex-pc", ["plan:create"]);
    const hermes = await clientOn(B, "hermes-admin", ["approve:decide"]);
    const plan = (await A.plane.request(
      { kind: "client", client: codex },
      { op: "plan", host: "agent-host", argv: CHANGE },
    )) as { operationId: string; fingerprint: string };
    await round([A, B]);
    await B.plane.revokeClient("hermes-admin");
    await round([A, B]);
    await B.rep.decide(hermes, plan.operationId, plan.fingerprint, "approve");
    await round([A, B]);
    expect(A.rep.replica.ops[plan.operationId]?.state).toBe("pending");
    expect(A.rep.replica.clients["hermes-admin"]?.revoked).toBe(true);
  });
});

describe("replica tamper and truncation", () => {
  test("a relayed entry that was changed after the fact blocks that origin", async () => {
    const clock = { now: 3_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const codex = await clientOn(A, "codex-pc", ["plan:create"]);
    await A.plane.request(
      { kind: "client", client: codex },
      { op: "plan", host: "agent-host", argv: CHANGE },
    );
    await round([A, B, C]);
    // New entries reach C only; B has not seen them yet.
    await A.plane.request(
      { kind: "client", client: codex },
      {
        op: "plan",
        host: "agent-host",
        argv: ["systemctl", "status", "nginx"],
      },
    );
    await round([A, C]);
    const honest = C.rep.serve(B.rep.request());
    const batch = honest.origins[A.id];
    expect(batch?.entries.length).toBeGreaterThan(0);
    const tampered = {
      origins: {
        ...honest.origins,
        [A.id]: {
          head: batch?.head ?? { seq: 0, hash: "" },
          entries: (batch?.entries ?? []).map((e, i) =>
            i === 0
              ? {
                  ...e,
                  envelope: { ...(e.envelope as object), state: "succeeded" },
                }
              : e,
          ),
        },
      },
    };
    const pull = await B.rep.receive(tampered, C.id);
    expect(pull.blocked).toContain(A.id);
    expect(B.rep.status().blocked[A.id]).toBe("rewritten");
  });

  test("a head that moved backwards is detected as truncation", async () => {
    const clock = { now: 4_000_000 };
    const { A, B } = await network(["A", "B"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
    }));
    const codex = await clientOn(A, "codex-pc", ["plan:create"]);
    await A.plane.request(
      { kind: "client", client: codex },
      { op: "plan", host: "agent-host", argv: CHANGE },
    );
    await A.plane.request(
      { kind: "client", client: codex },
      {
        op: "plan",
        host: "agent-host",
        argv: ["systemctl", "status", "nginx"],
      },
    );
    await round([A, B]);
    const known = B.rep.request().known[A.id];
    expect(known?.seq).toBeGreaterThan(1);
    const shorter = {
      origins: {
        [A.id]: { head: { seq: 1, hash: "a".repeat(64) }, entries: [] },
      },
    };
    const pull = await B.rep.receive(shorter, A.id);
    expect(pull.blocked).toContain(A.id);
    expect(B.rep.status().blocked[A.id]).toBe("truncated");
  });
});

describe("owner offline, takeover, and the returning owner", () => {
  test("an offline owner is taken over, and when it returns it cannot execute", async () => {
    const clock = { now: 5_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const codex = await clientOn(A, "codex-pc", ["plan:create"]);
    const plan = (await A.plane.request(
      { kind: "client", client: codex },
      { op: "plan", host: "agent-host", argv: CHANGE },
    )) as { operationId: string };
    await round([A, B, C]);

    // A goes silent. Before the window opens, takeover is refused.
    clock.now += LEASE_MS;
    await round([B, C]);
    await expectCode(
      B.rep.takeover(plan.operationId, "operator"),
      3,
      "Takeover possible after",
    );

    clock.now += SKEW_MS + 1_000;
    await B.rep.takeover(plan.operationId, "operator");
    await round([B, C]);
    expect(C.rep.replica.handoffs[plan.operationId]?.[2]?.[0]?.toOwner).toBe(
      B.id,
    );

    // A returns. Its lease with the others is stale, and after it syncs it learns it no longer owns the operation.
    await expectCode(
      A.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
      "lease expired",
    );
    await round([A, B, C]);
    await expectCode(
      A.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
      "now belongs to B",
    );
    expect(A.runs.length).toBe(0);

    // The new owner has the operation back in pending, which needs a fresh approval.
    const adopted = (await B.plane.listOperations({ all: true })).find(
      (op) => op.operationId === plan.operationId,
    );
    expect(adopted?.state).toBe("pending");
    expect(adopted?.needsApproval).toBe(true);
  });

  test("two takeovers at the same epoch are a conflict and nobody can run the operation", async () => {
    const clock = { now: 6_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const codex = await clientOn(A, "codex-pc", ["plan:create"]);
    const plan = (await A.plane.request(
      { kind: "client", client: codex },
      { op: "plan", host: "agent-host", argv: CHANGE },
    )) as { operationId: string };
    await round([A, B, C]);
    clock.now += LEASE_MS + SKEW_MS + 1_000;
    await B.rep.takeover(plan.operationId, "operator");
    await C.rep.takeover(plan.operationId, "operator");
    await round([B, C]);
    expect(B.rep.status().conflicts).toEqual([
      { opId: plan.operationId, epoch: 2, candidates: [B.id, C.id].sort() },
    ]);
    expect(C.rep.status().conflicts.length).toBe(1);
    await expectCode(
      B.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
    );
    await expectCode(
      C.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
    );
    expect(B.runs.length + C.runs.length).toBe(0);
  });

  test("takeover is refused when the new owner does not enroll the host", async () => {
    const clock = { now: 7_000_000 };
    const { A, B, C } = await network(["A", "B", "C"], clock).then((d) => ({
      A: d.A as Device,
      B: d.B as Device,
      C: d.C as Device,
    }));
    const codex = await clientOn(A, "codex-pc", ["plan:create"]);
    const plan = (await A.plane.request(
      { kind: "client", client: codex },
      { op: "plan", host: "agent-host", argv: CHANGE },
    )) as { operationId: string };
    await round([A, B, C]);
    // C's inventory does not contain the host.
    const inventory = join(C.plane.store.directory, "..", "inventory.yaml");
    await writeFile(inventory, INVENTORY.replace("agent-host:", "other-host:"));
    clock.now += LEASE_MS + SKEW_MS + 1_000;
    await expectCode(
      C.rep.takeover(plan.operationId, "operator"),
      3,
      "is not in this device's inventory",
    );
    expect(C.rep.replica.handoffs[plan.operationId]).toBeUndefined();
  });
});
