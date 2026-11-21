import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "../src/approvals/ledger";
import { agentMethod } from "../src/broker/agent-methods";
import { BasicPolicy } from "../src/broker/basic-policy";
import { Broker } from "../src/broker/engine";
import { proxmoxExecutor } from "../src/broker/proxmox-exec";
import { validateProxmoxInput } from "../src/broker/proxmox-plan";
import { BrokerStore } from "../src/broker/store";
import type { ExecutorPort, InventoryPort } from "../src/broker/types";
import { providerEntry } from "../src/control/proxmox-full";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import type { ApiFetch } from "../src/proxmox/api";
import { parseInventory } from "../src/inventory";
import type { Inventory, Machine } from "../src/types";

setDefaultTimeout(60_000);

// Proxmox requests through the broker, against a fake API. Synthetic names and
// addresses only; nothing contacts a node.
const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
const TOKEN = "PVEAPIToken=ops@pve!homectl=SECRET-VALUE-123";
const UPID = "UPID:pve-test:0001:0002:0003:qmstart:9001:ops@pve!homectl:";

let dir: string;
let clock = 1_800_000_000_000;
const now = () => clock;
const agent: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["pve-host"],
};
const brokers: Broker[] = [];
let calls: { method: string; path: string }[];
let inventory: Inventory;
let inventoryPath: string;

function inventoryText(caFile: string) {
  return `version: 1
session:
  ttl: 1h
  database: /tmp/homectl-synthetic/vault.kdbx
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
    operations: full
    vmid_range: [9001, 9010]
    protected_vmids: [9009]
    storages: [local-test]
    api:
      url: https://pve.example:8006
      ca_file: ${caFile}
      token_entry: homectl-pve-token
`;
}

// A fake API: reads return data with a secret field; changes return a task.
function fakeFetch(): ApiFetch {
  return async (url, init) => {
    const path = new URL(url).pathname.replace("/api2/json", "");
    const method = String(init.method);
    calls.push({ method, path });
    let data: unknown = { status: 500 };
    if (method === "GET" && path.endsWith("/config"))
      data = { memory: 2048, cipassword: "hunter2", name: "sample-vm" };
    else if (method === "GET" && path === "/access/users")
      data = [{ userid: "ops@pve" }];
    else if (method === "POST" || method === "PUT") data = UPID;
    else if (path.includes("/tasks/"))
      data = { status: "stopped", exitstatus: "OK" };
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
}

async function makeBroker() {
  const key = await loadOrCreateDeviceKey(dir);
  const executor: ExecutorPort = {
    run: async () => {
      throw new Error("no ssh in this test");
    },
    proxmox: proxmoxExecutor({
      inventoryPath,
      fetcher: fakeFetch(),
      tokenSource: async () => TOKEN,
      pollMs: 1,
    }),
  };
  const inventoryPort: InventoryPort = {
    machine: async (host) => inventory.machines[host] as Machine | undefined,
    hosts: async () => Object.keys(inventory.machines),
    providerFor: async (host) => providerEntry(inventory, host)?.[1],
  };
  const broker = new Broker({
    store: new BrokerStore(dir),
    ledger: new NonceLedger(dir, now),
    key,
    device: { id: "dev-test-0000000000", name: "test" },
    policy: new BasicPolicy(),
    inventory: inventoryPort,
    executor,
    now,
    approvalSurface: "http://127.0.0.1:7448/approvals",
  });
  await broker.init();
  brokers.push(broker);
  return { broker, key };
}

function decideFor(
  broker: Broker,
  id: string,
  fingerprint: string,
  stepUp: boolean,
) {
  return broker.decide({
    operationId: id,
    fingerprint,
    decision: "approve-once",
    surface: "panel",
    stepUp,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-broker-pve-"));
  clock = 1_800_000_000_000;
  calls = [];
  const caFile = join(dir, "ca.pem");
  await writeFile(caFile, PEM);
  inventoryPath = join(dir, "inventory.yaml");
  const text = inventoryText(caFile);
  await writeFile(inventoryPath, text);
  inventory = parseInventory(text);
});

afterEach(async () => {
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

describe("request shape", () => {
  test("a request is either an API call or a catalogue action", () => {
    expect(() =>
      validateProxmoxInput({
        host: "pve-host",
        method: "GET",
        path: "/version",
        catalogue: { kind: "qemu", action: "list" },
      }),
    ).toThrow("not both");
    expect(() => validateProxmoxInput({ host: "pve-host" })).toThrow(
      "either method and path",
    );
    expect(() =>
      validateProxmoxInput({ host: "pve-host", method: "PATCH", path: "/x" }),
    ).toThrow("method must be");
    expect(() =>
      validateProxmoxInput({
        host: "pve-host",
        method: "GET",
        path: "/x",
        extra: 1,
      }),
    ).toThrow("Unknown field");
    expect(
      validateProxmoxInput({
        host: "pve-host",
        method: "GET",
        path: "/version",
      }),
    ).toEqual({ host: "pve-host", method: "GET", path: "/version" });
  });
});

describe("planning and refusals", () => {
  test("refused requests never become operations", async () => {
    const { broker } = await makeBroker();
    const refused = [
      { method: "GET", path: "/nodes/other-node/qemu" },
      { method: "GET", path: "/not/a/route" },
      { method: "GET", path: "/nodes/pve-test/../x" },
      { method: "POST", path: "/nodes/pve-test/qemu/9050/status/start" },
      { method: "DELETE", path: "/nodes/pve-test/qemu/9009" },
      {
        method: "POST",
        path: "/nodes/pve-test/qemu/9001/config",
        params: { password: "hunter2" },
      },
      {
        method: "POST",
        path: "/nodes/pve-test/qemu/9001/status/start",
        params: { force: "1" },
      },
    ];
    for (const request of refused)
      await expect(
        broker.proxmox(agent, { host: "pve-host", ...request }),
      ).rejects.toThrow();
    expect(await broker.list(agent)).toHaveLength(0);
  });

  test("a host outside the caller's grants is refused like an unknown host", async () => {
    const { broker } = await makeBroker();
    await expect(
      broker.proxmox(
        { ...agent, hosts: ["nope"] },
        {
          host: "pve-host",
          method: "GET",
          path: "/version",
        },
      ),
    ).rejects.toThrow("not in this client's grants");
  });
});

describe("submit, queue, approve, execute", () => {
  test("a read runs without approval and its secret fields are redacted", async () => {
    const { broker } = await makeBroker();
    const view = await broker.proxmox(agent, {
      host: "pve-host",
      method: "GET",
      path: "/nodes/pve-test/qemu/9001/config",
    });
    await broker.settled();
    const done = await broker.status(agent, view.id);
    expect(done.state).toBe("succeeded");
    expect(done.result?.stdout).toContain("sample-vm");
    expect(done.result?.stdout).not.toContain("hunter2");
    expect(calls).toEqual([
      { method: "GET", path: "/nodes/pve-test/qemu/9001/config" },
    ]);
  });

  test("a change waits in the owner's queue with its risk, then runs once approved", async () => {
    const { broker } = await makeBroker();
    const view = await broker.proxmox(agent, {
      host: "pve-host",
      method: "POST",
      path: "/nodes/pve-test/qemu/9001/status/start",
    });
    expect(view.state).toBe("awaiting-approval");
    expect(view.risk).toBe("R2");
    expect(view.argv).toEqual([
      "proxmox-api",
      "POST",
      "/nodes/pve-test/qemu/9001/status/start",
    ]);
    expect(calls).toEqual([]);
    const pending = await broker.pending();
    expect(pending.map((op) => op.id)).toEqual([view.id]);
    const op = await broker.operation(view.id);
    expect(op?.impact).toBe("Start VM 9001");
    const result = await decideFor(broker, view.id, view.fingerprint, false);
    expect(result.grant).toBeDefined();
    await broker.settled();
    const done = await broker.status(agent, view.id);
    expect(done.state).toBe("succeeded");
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/nodes/pve-test/qemu/9001/status/start",
    });
  });

  test("a catalogue action goes through the same queue", async () => {
    const { broker } = await makeBroker();
    const view = await broker.proxmox(agent, {
      host: "pve-host",
      catalogue: { kind: "qemu", action: "start", vmid: 9001 },
    });
    expect(view.state).toBe("awaiting-approval");
    expect(view.argv).toEqual(["qm", "start", "9001"]);
    await decideFor(broker, view.id, view.fingerprint, false);
    await broker.settled();
    expect((await broker.status(agent, view.id)).state).toBe("succeeded");
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/nodes/pve-test/qemu/9001/status/start",
    });
  });

  test("a changed provider after submit fails the operation instead of running it", async () => {
    const { broker } = await makeBroker();
    const view = await broker.proxmox(agent, {
      host: "pve-host",
      method: "POST",
      path: "/nodes/pve-test/qemu/9001/status/start",
    });
    const provider = inventory.providers?.["pve-test"];
    if (provider) provider.protected_vmids = [9001];
    const result = await decideFor(broker, view.id, view.fingerprint, false);
    expect(result.operation.state).toBe("failed");
    expect(calls).toEqual([]);
  });
});

describe("agent routes", () => {
  test("/v1/proxmox submits through the same engine as the CLI and MCP", async () => {
    const { broker } = await makeBroker();
    const view = (await agentMethod(
      broker,
      "/v1/proxmox",
      {
        host: "pve-host",
        method: "POST",
        path: "/nodes/pve-test/qemu/9001/status/start",
        waitMs: 0,
      },
      agent,
    )) as { state: string; risk: string };
    expect(view.state).toBe("awaiting-approval");
    expect(view.risk).toBe("R2");
    expect(calls).toEqual([]);
  });

  test("unknown fields and an unknown path are refused on the route", async () => {
    const { broker } = await makeBroker();
    await expect(
      agentMethod(
        broker,
        "/v1/proxmox",
        { host: "pve-host", method: "GET", path: "/version", argv: ["x"] },
        agent,
      ),
    ).rejects.toThrow("Unknown field");
    expect(
      await agentMethod(broker, "/v1/proxmox-nope", {}, agent),
    ).toBeUndefined();
  });
});

describe("owner-only (R4) requests", () => {
  test("need the owner's password, and are not rememberable", async () => {
    const { broker } = await makeBroker();
    const view = await broker.proxmox(agent, {
      host: "pve-host",
      method: "GET",
      path: "/access/users",
    });
    expect(view.state).toBe("awaiting-approval");
    expect(view.risk).toBe("R4");
    const op = await broker.operation(view.id);
    expect(op?.decision.humanOnly).toBe(true);
    expect(op?.decision.stepUp).toBe(true);
    expect(op?.decision.source).toBe("hard-gate");
    await expect(
      decideFor(broker, view.id, view.fingerprint, false),
    ).rejects.toThrow("confirm your identity again");
    await expect(
      broker.decide({
        operationId: view.id,
        fingerprint: view.fingerprint,
        decision: "approve-remember",
        surface: "panel",
        stepUp: true,
      }),
    ).rejects.toThrow("cannot be remembered");
    expect(calls).toEqual([]);
    const result = await decideFor(broker, view.id, view.fingerprint, true);
    await broker.settled();
    expect(result.grant).toBeDefined();
    expect((await broker.status(agent, view.id)).state).toBe("succeeded");
    expect(calls).toEqual([{ method: "GET", path: "/access/users" }]);
  });

  test("the agent surface has no route to decide anything", async () => {
    const { broker } = await makeBroker();
    expect(
      await agentMethod(broker, "/v1/owner/decide", {}, agent),
    ).toBeUndefined();
  });

  test("the approval is refused for a rule-based or reviewed decision", async () => {
    const { broker } = await makeBroker();
    const view = await broker.proxmox(agent, {
      host: "pve-host",
      method: "DELETE",
      path: "/nodes/pve-test/qemu/9001/snapshot/before-upgrade",
    });
    const op = await broker.operation(view.id);
    expect(op?.risk).toBe("R4");
    expect(op?.decision.humanOnly).toBe(true);
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
