import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceKey,
  loadOrCreateDeviceKey,
} from "../src/control/device-key";
import {
  applyClient,
  applyDecision,
  applyHandoff,
  applyOp,
  type ClientBody,
  consumeDecision,
  type DecisionBody,
  type Envelope,
  emptyReplica,
  type HandoffBody,
  type OpBody,
  ownerAt,
  sealRecord,
} from "../src/control/replicate";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

type Dev = { id: string; key: DeviceKey };
async function device(): Promise<Dev> {
  const d = await mkdtemp(join(tmpdir(), "homectl-replicate-"));
  dirs.push(d);
  return { id: randomUUID(), key: await loadOrCreateDeviceKey(d) };
}
async function fleet() {
  const a = await device();
  const b = await device();
  const c = await device();
  const devices: Record<string, string> = {
    [a.id]: a.key.publicKey,
    [b.id]: b.key.publicKey,
    [c.id]: c.key.publicKey,
  };
  return { a, b, c, devices };
}
const opId = "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
function op(
  dev: Dev,
  planner: string,
  over: Partial<OpBody>,
): Envelope<OpBody> {
  return sealRecord(dev, {
    kind: "op",
    opId,
    owner: planner,
    planner,
    epoch: 1,
    seq: 1,
    state: "pending",
    host: "agent-host",
    argv: ["systemctl", "restart", "nginx"],
    impact: "Restart the web service",
    classification: "mutation",
    needsApproval: true,
    fingerprint: "a".repeat(64),
    issuer: "codex-pc",
    updatedAt: "2026-11-06T10:00:00.000Z",
    ...over,
  });
}
function bodyOf(dev: Dev, planner: string, over: Partial<OpBody>): OpBody {
  return { ...op(dev, planner, {}).body, ...over };
}
function handoff(
  dev: Dev,
  from: string,
  to: string,
  epoch: number,
): Envelope<HandoffBody> {
  return sealRecord<HandoffBody>(dev, {
    kind: "handoff",
    opId,
    fromOwner: from,
    toOwner: to,
    epoch,
    by: "operator",
    at: "2026-11-06T10:05:00.000Z",
  });
}

describe("signed records", () => {
  test("a record verifies only against its signer's registered key", async () => {
    const { a, b, devices } = await fleet();
    const first = op(a, a.id, {});
    const forged = { ...first, signer: b.id };
    const tampered = {
      ...first,
      body: { ...first.body, state: "succeeded" as const },
    };
    expect(applyOp(emptyReplica(), first, devices)).toBe("applied");
    expect(applyOp(emptyReplica(), forged, devices)).toBe("rejected");
    expect(applyOp(emptyReplica(), tampered, devices)).toBe("rejected");
    expect(
      applyOp(emptyReplica(), first, { [a.id]: devices[b.id] ?? "" }),
    ).toBe("rejected");
  });

  test("a snapshot from anyone other than the owner is refused", async () => {
    const { a, b, devices } = await fleet();
    const replica = emptyReplica();
    expect(applyOp(replica, op(a, a.id, {}), devices)).toBe("applied");
    // B claims the operation at a new state but is not the owner.
    expect(
      applyOp(replica, op(b, a.id, { state: "executing", seq: 2 }), devices),
    ).toBe("rejected");
    expect(replica.ops[opId]?.state).toBe("pending");
  });
});

describe("state lattice", () => {
  test("states move up only: a replayed approval cannot reopen an executed operation", async () => {
    const { a, devices } = await fleet();
    const replica = emptyReplica();
    expect(applyOp(replica, op(a, a.id, {}), devices)).toBe("applied");
    expect(
      applyOp(replica, op(a, a.id, { state: "approved", seq: 2 }), devices),
    ).toBe("applied");
    expect(
      applyOp(replica, op(a, a.id, { state: "executing", seq: 3 }), devices),
    ).toBe("applied");
    expect(
      applyOp(
        replica,
        op(a, a.id, { state: "succeeded", seq: 4, exitCode: 0 }),
        devices,
      ),
    ).toBe("applied");
    // A correctly signed "approved" from before execution arrives late.
    expect(
      applyOp(replica, op(a, a.id, { state: "approved", seq: 2 }), devices),
    ).toBe("stale");
    expect(
      applyOp(replica, op(a, a.id, { state: "pending", seq: 9 }), devices),
    ).toBe("stale");
    expect(replica.ops[opId]?.state).toBe("succeeded");
  });

  test("replicas receiving the same records in different orders converge", async () => {
    const { a, devices } = await fleet();
    const records = [
      op(a, a.id, {}),
      op(a, a.id, { state: "approved", seq: 2 }),
      op(a, a.id, { state: "executing", seq: 3 }),
      op(a, a.id, { state: "failed", seq: 4, exitCode: 3 }),
    ];
    const forward = emptyReplica();
    for (const r of records) applyOp(forward, r, devices);
    const reverse = emptyReplica();
    for (const r of [...records].reverse()) applyOp(reverse, r, devices);
    expect(reverse.ops[opId]?.state).toBe(forward.ops[opId]?.state);
    expect(reverse.ops[opId]?.state).toBe("failed");
  });
});

describe("decisions", () => {
  test("an approval signed by the approver's device is accepted once; replays are refused", async () => {
    const { a, b, c, devices } = await fleet();
    const decision = sealRecord<DecisionBody>(b, {
      kind: "decision",
      decisionId: randomUUID(),
      opId,
      targetOwner: a.id,
      fingerprint: "a".repeat(64),
      decision: "approve",
      approverClient: "hermes-admin",
      approverDevice: b.id,
      at: "2026-11-06T10:01:00.000Z",
    });
    const inbox = emptyReplica();
    expect(applyDecision(inbox, decision, devices)).toBe("applied");
    expect(applyDecision(inbox, decision, devices)).toBe("duplicate");
    consumeDecision(inbox, decision.body.decisionId);
    expect(applyDecision(inbox, decision, devices)).toBe("duplicate");
    // Signed by C while naming B as the approver's device: refused.
    const spoofed = sealRecord(c, {
      ...decision.body,
      decisionId: randomUUID(),
    });
    expect(applyDecision(inbox, spoofed, devices)).toBe("rejected");
  });
});

describe("handoffs", () => {
  test("an offline owner is taken over by one explicit signed handoff", async () => {
    const { a, c, devices } = await fleet();
    const replica = emptyReplica();
    applyOp(replica, op(a, a.id, {}), devices);
    expect(applyHandoff(replica, handoff(c, a.id, c.id, 2), devices)).toBe(
      "applied",
    );
    expect(ownerAt(replica, opId, 2)).toBe(c.id);
    // The old owner's later state change is no longer authoritative.
    expect(
      applyOp(replica, op(a, a.id, { state: "executing", seq: 2 }), devices),
    ).toBe("stale");
    const takenOver = sealRecord(
      c,
      bodyOf(a, a.id, { owner: c.id, epoch: 2, seq: 1, state: "executing" }),
    );
    expect(applyOp(replica, takenOver, devices)).toBe("applied");
  });

  test("a handoff signed by anyone but the taking device is refused", async () => {
    const { a, b, c, devices } = await fleet();
    const replica = emptyReplica();
    applyOp(replica, op(a, a.id, {}), devices);
    const forged = sealRecord<HandoffBody>(b, {
      kind: "handoff",
      opId,
      fromOwner: a.id,
      toOwner: c.id,
      epoch: 2,
      by: "operator",
      at: "2026-11-06T10:05:00.000Z",
    });
    expect(applyHandoff(replica, forged, devices)).toBe("rejected");
    expect(ownerAt(replica, opId, 2)).toBeUndefined();
  });

  test("two different takeovers at the same epoch become a conflict and nobody owns the operation", async () => {
    const { a, b, c, devices } = await fleet();
    const replica = emptyReplica();
    applyOp(replica, op(a, a.id, {}), devices);
    expect(applyHandoff(replica, handoff(b, a.id, b.id, 2), devices)).toBe(
      "applied",
    );
    expect(applyHandoff(replica, handoff(c, a.id, c.id, 2), devices)).toBe(
      "conflict",
    );
    expect(replica.conflicts).toEqual([
      { opId, epoch: 2, candidates: [b.id, c.id].sort() },
    ]);
    expect(ownerAt(replica, opId, 2)).toBeUndefined();
    // Fail closed: neither candidate can set state while the conflict stands.
    const asB = sealRecord(
      b,
      bodyOf(a, a.id, { owner: b.id, epoch: 2, seq: 1, state: "executing" }),
    );
    const asC = sealRecord(
      c,
      bodyOf(a, a.id, { owner: c.id, epoch: 2, seq: 1, state: "executing" }),
    );
    expect(applyOp(replica, asB, devices)).toBe("rejected");
    expect(applyOp(replica, asC, devices)).toBe("rejected");
  });
});

describe("client registrations", () => {
  const client = (dev: Dev, over: Partial<ClientBody>): Envelope<ClientBody> =>
    sealRecord(dev, {
      kind: "client",
      clientId: "codex-pc",
      device: dev.id,
      name: "Codex PC",
      scopes: ["plan:create", "status:read"],
      hosts: ["agent-host"],
      createdAt: "2026-11-06T09:00:00.000Z",
      revoked: false,
      ...over,
    });

  test("only the device holding a registration may describe it", async () => {
    const { b, c, devices } = await fleet();
    const replica = emptyReplica();
    expect(applyClient(replica, client(b, {}), devices)).toBe("applied");
    const impostor = sealRecord(c, { ...client(b, {}).body });
    expect(applyClient(replica, impostor, devices)).toBe("rejected");
  });

  test("revocation propagates and never reverts", async () => {
    const { b, devices } = await fleet();
    const replica = emptyReplica();
    applyClient(replica, client(b, {}), devices);
    expect(
      applyClient(
        replica,
        client(b, { revoked: true, revokedAt: "2026-11-06T10:10:00.000Z" }),
        devices,
      ),
    ).toBe("applied");
    expect(applyClient(replica, client(b, {}), devices)).toBe("stale");
    expect(replica.clients["codex-pc"]?.revoked).toBe(true);
    expect(replica.clients["codex-pc"]?.revokedAt).toBe(
      "2026-11-06T10:10:00.000Z",
    );
  });
});
