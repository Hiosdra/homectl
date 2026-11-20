// Execution semantics (homelab #21 §7): an operation runs at most once per
// approval, nothing is resubmitted or rolled back by homectl, and the agent's
// own verification is recorded separately from the process exit status.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  hosts: ["nas"],
};
const other: ClientIdentity = { ...agent, id: "claude-laptop" };
const machines: Record<string, Machine> = {
  nas: { description: "NAS", transport: "ssh", access: "full", user: "admin" },
};
const RESTART = ["systemctl", "restart", "nginx"];
const STOP = ["systemctl", "stop", "nginx"];
let calls: string[][];
let outcome: (argv: string[]) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};
const brokers: Broker[] = [];

const executor: ExecutorPort = {
  run: async ({ argv }) => {
    calls.push(argv);
    return outcome(argv);
  },
};

async function makeBroker(port: ExecutorPort = executor) {
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
    executor: port,
    now,
    approvalSurface: "http://127.0.0.1:7448/approvals",
  });
  await broker.init();
  brokers.push(broker);
  return broker;
}

// Owner approves the request as the panel would, once.
async function approve(
  broker: Broker,
  view: { id: string; fingerprint: string },
) {
  await broker.decide({
    operationId: view.id,
    fingerprint: view.fingerprint,
    decision: "approve-once",
    surface: "panel",
    stepUp: false,
  });
  await broker.settled();
}

// Lets time pass, then asks the broker for everything it could do on its own.
async function letTimePass(broker: Broker, id: string) {
  clock += 60 * 60_000;
  await broker.status(agent, id);
  await broker.wait(agent, id, 0);
  await broker.list(agent);
  await broker.settled();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-execution-"));
  clock = 1_800_000_000_000;
  calls = [];
  outcome = () => ({ exitCode: 0, stdout: "ok\n", stderr: "" });
});
afterEach(async () => {
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

describe("no resubmission after a result", () => {
  test("a failed operation is not dispatched again without a new agent request", async () => {
    const broker = await makeBroker();
    outcome = () => ({ exitCode: 1, stdout: "", stderr: "unit failed\n" });
    const view = await broker.exec(agent, { host: "nas", argv: RESTART });
    await approve(broker, view);
    expect((await broker.status(agent, view.id)).state).toBe("failed");
    await letTimePass(broker, view.id);
    expect(calls).toEqual([RESTART]);
    expect((await broker.status(agent, view.id)).state).toBe("failed");
    expect(await broker.pending()).toEqual([]);

    // Only a fresh request creates new work, and it waits for approval.
    const again = await broker.exec(agent, { host: "nas", argv: RESTART });
    expect(again.id).not.toBe(view.id);
    expect(again.state).toBe("awaiting-approval");
    await broker.settled();
    expect(calls).toEqual([RESTART]);
  });

  test("an operation with an unknown outcome is not dispatched again either", async () => {
    const crashing: ExecutorPort = {
      run: async ({ argv }) => {
        calls.push(argv);
        throw new Error("connection dropped mid-run");
      },
    };
    const broker = await makeBroker(crashing);
    const view = await broker.exec(agent, { host: "nas", argv: RESTART });
    await approve(broker, view);
    expect((await broker.status(agent, view.id)).state).toBe("unknown");
    await letTimePass(broker, view.id);
    expect(calls).toEqual([RESTART]);
    expect((await broker.status(agent, view.id)).state).toBe("unknown");
  });
});

describe("no automatic rollback", () => {
  test("a failed command is never undone; a compensating step needs its own approval", async () => {
    const broker = await makeBroker();
    outcome = () => ({ exitCode: 1, stdout: "", stderr: "restart failed\n" });
    const view = await broker.exec(agent, { host: "nas", argv: RESTART });
    await approve(broker, view);
    await letTimePass(broker, view.id);
    expect(calls).toEqual([RESTART]);

    // The agent may propose a compensating step; homectl only queues it.
    const rollback = await broker.exec(agent, { host: "nas", argv: STOP });
    await broker.settled();
    expect(rollback.state).toBe("awaiting-approval");
    expect(calls).toEqual([RESTART]);

    outcome = () => ({ exitCode: 0, stdout: "", stderr: "" });
    await approve(broker, rollback);
    expect(calls).toEqual([RESTART, STOP]);
    expect((await broker.status(agent, view.id)).state).toBe("failed");
  });
});

describe("agent-reported verification", () => {
  test("a successful exit can be reported as a failed check without changing the state", async () => {
    const broker = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: RESTART });
    await approve(broker, view);
    const done = await broker.status(agent, view.id);
    expect(done.state).toBe("succeeded");
    expect(done.verification).toBeUndefined();

    const reported = await broker.verify(agent, view.id, {
      status: "failed",
      summary: "nginx answers 502 on /health",
    });
    expect(reported.state).toBe("succeeded");
    expect(reported.result?.exitCode).toBe(0);
    expect(reported.verification).toMatchObject({
      status: "failed",
      summary: "nginx answers 502 on /health",
    });
    expect((await broker.status(agent, view.id)).state).toBe("succeeded");
  });

  test("a failed exit can be reported as a passed check without changing the state", async () => {
    const broker = await makeBroker();
    outcome = () => ({ exitCode: 1, stdout: "", stderr: "" });
    const view = await broker.exec(agent, { host: "nas", argv: RESTART });
    await approve(broker, view);
    const reported = await broker.verify(agent, view.id, {
      status: "passed",
      summary: "health endpoint returns 200",
    });
    expect(reported.state).toBe("failed");
    expect(reported.result?.exitCode).toBe(1);
    expect(reported.verification?.status).toBe("passed");
  });

  test("only the owning client may verify, only after the run, and only once", async () => {
    const broker = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: RESTART });
    const report = { status: "passed", summary: "checked" };
    await expect(broker.verify(agent, view.id, report)).rejects.toThrow(
      "Verify an operation after it has run",
    );
    await approve(broker, view);
    await expect(broker.verify(other, view.id, report)).rejects.toThrow(
      "Unknown operation",
    );
    await broker.verify(agent, view.id, report);
    await expect(broker.verify(agent, view.id, report)).rejects.toThrow(
      "already verified",
    );
  });

  test("malformed reports are refused and leave nothing behind", async () => {
    const broker = await makeBroker();
    const view = await broker.exec(agent, { host: "nas", argv: RESTART });
    await approve(broker, view);
    await expect(
      broker.verify(agent, view.id, { status: "ok", summary: "x" }),
    ).rejects.toThrow("must be passed, failed or inconclusive");
    await expect(
      broker.verify(agent, view.id, {
        status: "passed",
        summary: "x",
        exitCode: 0,
      }),
    ).rejects.toThrow("Unknown verification field");
    await expect(
      broker.verify(agent, view.id, { status: "passed", summary: "  " }),
    ).rejects.toThrow("summary is required");
    expect((await broker.status(agent, view.id)).verification).toBeUndefined();
  });
});
