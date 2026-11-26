// Broker engine driven by the real authz policy file (homelab #21 B5/B6).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "../src/approvals/ledger";
import { Broker } from "../src/broker/engine";
import { BrokerStore } from "../src/broker/store";
import type { ExecutorPort } from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import type { Machine } from "../src/types";

let dir: string;
const clock = 1_800_000_000_000;
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
const executor: ExecutorPort = {
  run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
};
const brokers: Broker[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-broker-authz-"));
});
afterEach(async () => {
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

describe("with the real authz policy", () => {
  async function authzBroker() {
    const { AuthzPolicy } = await import("../src/broker/authz-policy");
    const policy = new AuthzPolicy({ path: join(dir, "policy.json"), now });
    const key = await loadOrCreateDeviceKey(dir);
    const broker = new Broker({
      store: new BrokerStore(dir),
      ledger: new NonceLedger(dir, now),
      key,
      device: { id: "dev-test-0000000000", name: "test" },
      policy,
      inventory: {
        machine: async (h) => machines[h],
        hosts: async () => Object.keys(machines),
      },
      executor,
      now,
    });
    await broker.init();
    brokers.push(broker);
    return { broker, policy };
  }

  test("approve-and-remember runs now and covers only the exact command next time", async () => {
    const { broker, policy } = await authzBroker();
    const argv = ["systemctl", "restart", "nginx"];
    const first = await broker.exec(agent, { host: "nas", argv });
    expect(first.state).toBe("awaiting-approval");
    await broker.decide({
      operationId: first.id,
      fingerprint: first.fingerprint,
      decision: "approve-remember",
      surface: "cli",
      stepUp: false,
    });
    expect((await broker.operation(first.id))?.rememberedRule).toMatch(
      /^remembered-/,
    );
    await broker.settled();
    // The grant was bound to the revision after the rule was saved.
    expect((await broker.status(agent, first.id)).state).toBe("succeeded");
    expect(await policy.revision()).toBe(1);

    const again = await broker.exec(agent, { host: "nas", argv });
    await broker.settled();
    expect((await broker.status(agent, again.id)).state).toBe("succeeded");
    const longer = await broker.exec(agent, {
      host: "nas",
      argv: [...argv, "postgres"],
    });
    expect(longer.state).toBe("awaiting-approval");
    const otherClient = await broker.exec(other, { host: "nas", argv });
    expect(otherClient.state).toBe("awaiting-approval");
  });

  test("safe reads never hit the risk budget", async () => {
    const { broker, policy } = await authzBroker();
    const doc = await policy.document();
    await policy.save({
      ...doc,
      budgets: { ...doc.budgets, clientMaxRiskPoints: 3 },
    });
    for (let i = 0; i < 10; i++) {
      const view = await broker.exec(agent, { host: "nas", argv: ["uptime"] });
      expect(view.state).not.toBe("awaiting-approval");
    }
    await broker.settled();
  });
});
