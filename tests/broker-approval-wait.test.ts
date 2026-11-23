import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "../src/approvals/ledger";
import {
  APPROVAL_WAIT_DEFAULT_MS,
  APPROVAL_WAIT_MAX_MS,
  describeApprovalWait,
  parseApprovalWait,
  readApprovalWait,
  writeApprovalWait,
} from "../src/broker/approval-wait";
import { BasicPolicy } from "../src/broker/basic-policy";
import { Broker } from "../src/broker/engine";
import { ScanRecords } from "../src/broker/scan-records";
import { SettingsRoutes } from "../src/broker/settings-routes";
import { BrokerStore } from "../src/broker/store";
import { ownerSetupPort } from "../src/broker/setup-exec";
import { validateSetupInput } from "../src/broker/setup-request";
import type { ExecutorPort } from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import { HomectlError, type Machine } from "../src/types";

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

let dir: string;
let clock = 1_800_000_000_000;
const now = () => clock;
const agent: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["nas"],
};
let machines: Record<string, Machine>;
let calls: string[][];
const executor: ExecutorPort = {
  run: async ({ argv }) => {
    calls.push(argv);
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  },
};
const brokers: Broker[] = [];

async function brokerWithWait(approvalWaitMs?: () => Promise<number>) {
  const broker = new Broker({
    store: new BrokerStore(dir),
    ledger: new NonceLedger(dir, now),
    key: await loadOrCreateDeviceKey(dir),
    device: { id: "dev-test-0000000000", name: "test" },
    policy: new BasicPolicy(),
    inventory: {
      machine: async (h) => machines[h],
      hosts: async () => Object.keys(machines),
    },
    executor,
    now,
    ...(approvalWaitMs ? { approvalWaitMs } : {}),
  });
  await broker.init();
  brokers.push(broker);
  return broker;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-wait-"));
  clock = 1_800_000_000_000;
  machines = {
    nas: {
      description: "NAS",
      transport: "ssh",
      access: "full",
      user: "admin",
    },
  };
  calls = [];
});
afterEach(async () => {
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

describe("approval wait: bounds and words", () => {
  test("parses minutes, hours, days and bare minutes", () => {
    expect(parseApprovalWait("90m")).toBe(90 * MINUTE);
    expect(parseApprovalWait("24h")).toBe(24 * HOUR);
    expect(parseApprovalWait("7d")).toBe(APPROVAL_WAIT_MAX_MS);
    expect(parseApprovalWait(90)).toBe(90 * MINUTE);
  });

  test("refuses values outside 5 minutes to 7 days, rather than clamping", () => {
    for (const bad of ["4m", "8d", "0", "", "soon", "24x", 1, "99999h"]) {
      expect(() => parseApprovalWait(bad)).toThrow(HomectlError);
    }
  });

  test("describes the wait in plain words", () => {
    expect(describeApprovalWait(24 * HOUR)).toBe("1 day");
    expect(describeApprovalWait(2 * HOUR)).toBe("2 hours");
    expect(describeApprovalWait(90 * MINUTE)).toBe("90 minutes");
  });
});

describe("approval wait: the saved setting", () => {
  test("the default is 24 hours when nothing is saved", async () => {
    expect(await readApprovalWait(dir)).toBe(APPROVAL_WAIT_DEFAULT_MS);
    expect(APPROVAL_WAIT_DEFAULT_MS).toBe(24 * HOUR);
  });

  test("a damaged file reads as the default, never as a short wait", async () => {
    await writeFile(join(dir, "approval-wait.json"), "{not json");
    expect(await readApprovalWait(dir)).toBe(APPROVAL_WAIT_DEFAULT_MS);
  });

  test("a saved value round-trips and is written privately", async () => {
    await writeApprovalWait(dir, 2 * HOUR);
    expect(await readApprovalWait(dir)).toBe(2 * HOUR);
    const text = await readFile(join(dir, "approval-wait.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ version: 1, approvalWaitMs: 2 * HOUR });
  });

  test("writes outside the bounds are refused and nothing is saved", async () => {
    await expect(writeApprovalWait(dir, 60_000)).rejects.toThrow(HomectlError);
    expect(await readApprovalWait(dir)).toBe(APPROVAL_WAIT_DEFAULT_MS);
  });
});

describe("approval wait: how long a request waits", () => {
  test("a new request waits 24 hours by default", async () => {
    const broker = await brokerWithWait();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "nginx"],
    });
    expect(Date.parse(view.expiresAt) - Date.parse(view.createdAt)).toBe(
      24 * HOUR,
    );
  });

  test("still waiting after 23 hours, and the owner can approve it", async () => {
    const broker = await brokerWithWait();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "nginx"],
    });
    clock += 23 * HOUR;
    expect((await broker.status(agent, view.id)).state).toBe(
      "awaiting-approval",
    );
    await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: false,
    });
    await broker.settled();
    expect((await broker.status(agent, view.id)).state).toBe("succeeded");
    expect(calls).toHaveLength(1);
  });

  test("expires after 24 hours", async () => {
    const broker = await brokerWithWait();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "nginx"],
    });
    clock += 24 * HOUR + 1;
    expect((await broker.status(agent, view.id)).state).toBe("expired");
    expect(calls).toHaveLength(0);
  });

  test("the saved owner setting sets the wait for new requests", async () => {
    await writeApprovalWait(dir, 2 * HOUR);
    const broker = await brokerWithWait(() => readApprovalWait(dir));
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "nginx"],
    });
    expect(Date.parse(view.expiresAt) - Date.parse(view.createdAt)).toBe(
      2 * HOUR,
    );
    clock += 2 * HOUR + 1;
    expect((await broker.status(agent, view.id)).state).toBe("expired");
  });

  test("after a long wait a changed machine is refused, not run", async () => {
    const broker = await brokerWithWait();
    const view = await broker.exec(agent, {
      host: "nas",
      argv: ["systemctl", "restart", "nginx"],
    });
    clock += 23 * HOUR;
    const nas = machines.nas;
    if (!nas) throw new Error("Missing NAS fixture");
    machines.nas = { ...nas, access: "user" };
    const decided = await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: false,
    });
    expect(decided.operation.state).toBe("failed");
    expect(decided.operation.reason).toBe("plan-changed");
    await broker.settled();
    expect(calls).toHaveLength(0);
  });
});

describe("owner route for the approval wait", () => {
  const goodPassword = async (password: unknown) => {
    if (password !== "owner-secret")
      throw new HomectlError(3, "Confirm with the owner password");
  };

  test("changing it needs the owner password, and a wrong one saves nothing", async () => {
    const routes = new SettingsRoutes(dir);
    await expect(
      routes.owner(
        "/v1/owner/settings/approval-wait",
        { wait: "2h", password: "wrong" },
        goodPassword,
      ),
    ).rejects.toThrow("Confirm with the owner password");
    expect(await readApprovalWait(dir)).toBe(APPROVAL_WAIT_DEFAULT_MS);
  });

  test("with the password it saves and reports the plain label", async () => {
    const routes = new SettingsRoutes(dir);
    const view = (await routes.owner(
      "/v1/owner/settings/approval-wait",
      { wait: "2h", password: "owner-secret" },
      goodPassword,
    )) as { approvalWaitMs: number; label: string };
    expect(view).toMatchObject({ approvalWaitMs: 2 * HOUR, label: "2 hours" });
    expect(await readApprovalWait(dir)).toBe(2 * HOUR);
  });

  test("the read route needs no password and changes nothing", async () => {
    const routes = new SettingsRoutes(dir);
    const view = (await routes.owner(
      "/v1/owner/settings/approval-wait/get",
      {},
      goodPassword,
    )) as { approvalWaitMs: number };
    expect(view.approvalWaitMs).toBe(APPROVAL_WAIT_DEFAULT_MS);
  });
});

describe("approval wait as an agent request", () => {
  test("the agent sends a duration; the request carries checked milliseconds", () => {
    const input = validateSetupInput("approval-wait", { wait: "2h" });
    expect(input.waitMs).toBe(2 * HOUR);
  });

  test("a password or any other field is refused by name", () => {
    expect(() =>
      validateSetupInput("approval-wait", { wait: "2h", password: "x" }),
    ).toThrow("Unknown field: password");
  });

  test("an out-of-range wait is refused before anything is queued", () => {
    expect(() => validateSetupInput("approval-wait", { wait: "30d" })).toThrow(
      HomectlError,
    );
  });

  test("an approved request calls the settings route with the checked value", async () => {
    const sent: [string, Record<string, unknown>][] = [];
    const port = ownerSetupPort({
      scans: new ScanRecords(dir),
      hosts: async () => ({}),
      policy: async () => ({}),
      settings: async (path, input) => {
        sent.push([path, input]);
        return { approvalWaitMs: 2 * HOUR, label: "2 hours" };
      },
    });
    const result = await port.run({
      kind: "approval-wait",
      input: { waitMs: 2 * HOUR },
    });
    expect(sent).toEqual([
      ["/v1/owner/settings/approval-wait", { waitMs: 2 * HOUR }],
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 hours");
  });
});
