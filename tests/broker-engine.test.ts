import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGrant, issueGrant } from "../src/approvals/grant";
import { NonceLedger } from "../src/approvals/ledger";
import { BasicPolicy } from "../src/broker/basic-policy";
import { Broker } from "../src/broker/engine";
import { BrokerStore } from "../src/broker/store";
import type { ExecutorPort } from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import type { Machine } from "../src/types";

let dir: string;
let clock = 1_800_000_000_000;
const now = () => clock;
const agent: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["nas", "box"],
};
const other: ClientIdentity = { ...agent, id: "claude-laptop" };
let machines: Record<string, Machine>;
let calls: string[][];
let executor: ExecutorPort;
const brokers: Broker[] = [];

async function makeBroker() {
  const key = await loadOrCreateDeviceKey(dir);
  const broker = new Broker({
    store: new BrokerStore(dir),
    ledger: new NonceLedger(dir, now),
    key,
    device: { id: "dev-test-0000000000", name: "test" },
    policy: new BasicPolicy(),
    inventory: {
      machine: async (h) => machines[h],
      hosts: async () => Object.keys(machines),
    },
    executor,
    now,
    approvalSurface: "http://127.0.0.1:7448/approvals",
  });
  await broker.init();
  brokers.push(broker);
  return { broker, key };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-broker-"));
  clock = 1_800_000_000_000;
  machines = {
    nas: {
      description: "NAS",
      transport: "ssh",
      access: "full",
      user: "admin",
    },
    box: { description: "box", transport: "ssh", access: "user", user: "op" },
  };
  calls = [];
  executor = {
    run: async ({ argv }) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  };
});
afterEach(async () => {
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

describe("agent requests", () => {
  test("safe inspection runs without approval", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: ["uptime"] });
    await broker.settled();
    const done = await broker.status(agent, view.id);
    expect(done.state).toBe("succeeded");
    expect(done.result?.stdout).toBe("ok\n");
    expect(calls).toEqual([["uptime"]]);
  });

  test("ungranted and unknown hosts get the same refusal", async () => {
    const { broker } = await makeBroker();
    const limited = { ...agent, hosts: ["box"] };
    const a = await broker
      .exec(limited, { host: "nas", argv: ["uptime"] })
      .catch((e) => e.message);
    const b = await broker
      .exec(agent, { host: "ghost", argv: ["uptime"] })
      .catch((e) => e.message);
    expect(a).toBe(b);
  });

  test("tier screening from 0.2 still applies", async () => {
    const { broker } = await makeBroker();
    await expect(
      broker.exec(agent, { host: "box", argv: ["sudo", "-n", "reboot"] }),
    ).rejects.toThrow("Sudo is forbidden");
  });

  test("unknown request fields are rejected", async () => {
    const { broker } = await makeBroker();
    await expect(
      broker.exec(agent, { host: "nas", argv: ["uptime"], approval: "x" }),
    ).rejects.toThrow("Unknown field");
  });

  test("a mutation waits for the owner; nothing runs before approval", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "nginx"],
    });
    expect(view.state).toBe("awaiting-approval");
    expect(view.approvalSurface).toContain("approvals");
    await broker.settled();
    expect(calls).toEqual([]);
  });

  test("clients cannot see each other's operations", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: ["uptime"] });
    await expect(broker.status(other, view.id)).rejects.toThrow(
      "Unknown operation",
    );
    expect(await broker.list(other)).toEqual([]);
  });
});

describe("owner decisions", () => {
  test("approve once dispatches exactly once", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "nginx"],
    });
    const decided = await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: false,
    });
    expect(decided.grant?.operationId).toBe(view.id);
    expect(JSON.stringify(decided)).not.toContain("signature");
    await broker.settled();
    expect((await broker.status(agent, view.id)).state).toBe("succeeded");
    await expect(
      broker.decide({
        operationId: view.id,
        fingerprint: view.fingerprint,
        decision: "approve-once",
        surface: "panel",
        stepUp: false,
      }),
    ).rejects.toThrow("already decided");
    await broker.settled();
    expect(calls.length).toBe(1);
  });

  test("R3/R4 need step-up", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["rm", "-rf", "/srv/old"],
    });
    expect(view.risk).toBe("R4");
    await expect(
      broker.decide({
        operationId: view.id,
        fingerprint: view.fingerprint,
        decision: "approve-once",
        surface: "panel",
        stepUp: false,
      }),
    ).rejects.toThrow("confirm your identity");
    await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: true,
    });
    await broker.settled();
    expect(calls).toEqual([["rm", "-rf", "/srv/old"]]);
  });

  test("a wrong fingerprint is refused", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "x"],
    });
    await expect(
      broker.decide({
        operationId: view.id,
        fingerprint: "0".repeat(64),
        decision: "approve-once",
        surface: "panel",
        stepUp: false,
      }),
    ).rejects.toThrow("plan changed");
  });

  test("an inventory change after planning invalidates the plan", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "x"],
    });
    machines.nas = { ...machines.nas, user: "someone-else" } as Machine;
    const result = await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: false,
    });
    expect(result.operation.state).toBe("failed");
    expect(result.operation.reason).toBe("plan-changed");
    await broker.settled();
    expect(calls).toEqual([]);
  });

  test("approval window expiry", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "x"],
    });
    clock += 16 * 60_000;
    expect((await broker.status(agent, view.id)).state).toBe("expired");
  });

  test("deny, revise and agent cancel close the operation without running", async () => {
    const { broker } = await makeBroker();
    for (const decision of ["deny-once", "revise"] as const) {
      const view = await broker.exec(agent, {
        host: "nas",
        argv: ["systemctl", "restart", decision],
      });
      const r = await broker.decide({
        operationId: view.id,
        fingerprint: view.fingerprint,
        decision,
        surface: "panel",
        stepUp: false,
      });
      expect(["denied", "cancelled"]).toContain(r.operation.state);
    }
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "z"],
    });
    expect((await broker.cancel(agent, view.id)).state).toBe("cancelled");
    await broker.settled();
    expect(calls).toEqual([]);
  });

  test("remembering is refused for human-only actions", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: ["rm", "x"] });
    await expect(
      broker.decide({
        operationId: view.id,
        fingerprint: view.fingerprint,
        decision: "approve-remember",
        surface: "panel",
        stepUp: true,
      }),
    ).rejects.toThrow("cannot be remembered");
  });
});

describe("execution semantics", () => {
  test("nonzero exit is a failed process outcome, not retried", async () => {
    executor = {
      run: async ({ argv }) => {
        calls.push(argv);
        return { exitCode: 3, stdout: "", stderr: "bad" };
      },
    };
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: ["uptime"] });
    await broker.settled();
    const done = await broker.status(agent, view.id);
    expect(done.state).toBe("failed");
    expect(done.result?.exitCode).toBe(3);
    expect(calls.length).toBe(1);
  });

  test("an executor crash is reported as unknown", async () => {
    executor = {
      run: async () => {
        throw new Error("connection dropped");
      },
    };
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: ["uptime"] });
    await broker.settled();
    expect((await broker.status(agent, view.id)).state).toBe("unknown");
  });

  test("daemon restart marks in-flight work unknown", async () => {
    let release: () => void = () => {};
    executor = {
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
        }),
    };
    const first = await makeBroker();
    const view = await first.broker.exec(agent, {
      host: "nas",
      argv: ["uptime"],
    });
    const second = await makeBroker();
    expect((await second.broker.status(agent, view.id)).state).toBe("unknown");
    release();
    await first.broker.settled();
  });

  test("output is bounded", async () => {
    executor = {
      run: async () => ({
        exitCode: 0,
        stdout: "x".repeat(300_000),
        stderr: "",
      }),
    };
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: ["uptime"] });
    await broker.settled();
    const done = await broker.status(agent, view.id);
    expect(done.result?.truncated).toBe(true);
    expect(done.result?.stdout.length).toBe(256 * 1024);
  });

  test("wait returns once the owner decided and the work finished", async () => {
    const { broker } = await makeBroker();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "w"],
    });
    const waiting = broker.wait(agent, view.id, 5000);
    await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: false,
    });
    await broker.settled();
    expect((await waiting).state).toBe("succeeded");
  });
});

describe("tasks", () => {
  test("tasks track usage and closed tasks refuse new work", async () => {
    const { broker } = await makeBroker();
    const task = await broker.openTask(agent, { title: "Check NAS" });
    await broker.exec(agent, { host: "nas", argv: ["uptime"], task: task.id });
    await broker.settled();
    await broker.closeTask(agent, task.id);
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["uptime"],
      task: task.id,
    });
    expect(view.state).toBe("denied");
    await expect(
      broker.exec(other, { host: "nas", argv: ["uptime"], task: task.id }),
    ).rejects.toThrow("Unknown task");
  });
});

describe("grants", () => {
  test("forged, altered and replayed grants are rejected", async () => {
    const { key } = await makeBroker();
    const otherKey = await loadOrCreateDeviceKey(join(dir, "elsewhere"));
    const input = {
      operationId: "op_1",
      fingerprint: "f".repeat(64),
      client: "codex-pc",
      policyRevision: 1,
      device: "d",
      surface: "panel",
      stepUp: false,
      now: clock,
    };
    const expected = {
      operationId: "op_1",
      fingerprint: "f".repeat(64),
      client: "codex-pc",
      policyRevision: 1,
      stepUpRequired: false,
      now: clock,
    };
    const grant = issueGrant(key, input);
    expect(checkGrant(key.publicKey, grant, expected).ok).toBe(true);
    expect(
      checkGrant(key.publicKey, issueGrant(otherKey, input), expected),
    ).toEqual({ ok: false, reason: "signature" });
    expect(
      checkGrant(
        key.publicKey,
        { ...grant, fingerprint: "e".repeat(64) },
        expected,
      ),
    ).toEqual({ ok: false, reason: "signature" });
    expect(
      checkGrant(key.publicKey, grant, { ...expected, operationId: "op_2" }),
    ).toEqual({ ok: false, reason: "operation" });
    expect(
      checkGrant(key.publicKey, grant, { ...expected, policyRevision: 2 }),
    ).toEqual({ ok: false, reason: "policy-revision" });
    expect(
      checkGrant(key.publicKey, grant, { ...expected, stepUpRequired: true }),
    ).toEqual({ ok: false, reason: "step-up" });
    expect(
      checkGrant(key.publicKey, grant, {
        ...expected,
        now: clock + 10 * 60_000,
      }),
    ).toEqual({ ok: false, reason: "expired" });
    const ledger = new NonceLedger(dir, now);
    expect(await ledger.consume(grant.nonce, grant.expiresAt)).toBe(true);
    expect(await ledger.consume(grant.nonce, grant.expiresAt)).toBe(false);
  });

  test("concurrent consumption: exactly one wins", async () => {
    const a = new NonceLedger(dir, now);
    const b = new NonceLedger(dir, now);
    const results = await Promise.all([
      a.consume("n", clock + 1000),
      b.consume("n", clock + 1000),
      a.consume("n", clock + 1000),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
  });
});
