// The scan gate for enrolment (0.3 acceptance). Planning an agent request never
// contacts the network: a spy runner fails the test if anything runs. Enrolment is
// allowed only for an address with a recent scan the owner approved (or an owner
// scan), and the key is read again at execution: a changed key is refused. Nothing
// reaches a real machine; the scan runner is a stub.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "../src/approvals/ledger";
import { BasicPolicy } from "../src/broker/basic-policy";
import { Broker } from "../src/broker/engine";
import { OwnerHostRoutes } from "../src/broker/owner-hosts";
import { ScanRecords, SCAN_FRESH_MS } from "../src/broker/scan-records";
import { ownerSetupPort, type OwnerCall } from "../src/broker/setup-exec";
import { BrokerStore } from "../src/broker/store";
import type {
  ExecutorPort,
  InventoryPort,
  SetupRun,
} from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import { sessionPaths } from "../src/session";
import type { Machine, ProcessSpec } from "../src/types";
import { keyFingerprint } from "../src/broker/host-keys";

setDefaultTimeout(60_000);

const ADDRESS = "192.0.2.61";
// A synthetic ed25519 key (valid format, not a real machine's key).
const BLOB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIBVnTGs5JuBXNWbmPAEQX0mCqMnIDoNtKLkV0w8ptQaH";
const FP = keyFingerprint(BLOB);
// A second key for a machine that changed; only its fingerprint is compared.
const OTHER_FP = keyFingerprint(
  "AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyForChangedMachineTestsOnly0000000000",
);
const T0 = 1_800_000_000_000;

let dir: string;
let inventoryPath: string;
let clockNow: number;
let runnerCalls: ProcessSpec[];
let keyscanOutput: string;

const agent: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["nas"],
};

const nas = {
  description: "Synthetic test machine",
  transport: "ssh",
  access: "user",
  address: "192.0.2.10",
  user: "ops",
  ssh_alias: "nas",
} as unknown as Machine;

// The runner the scan path uses. Any call is recorded; the planning tests assert
// that none happens while requests are planned.
const runner = async (spec: ProcessSpec) => {
  runnerCalls.push(spec);
  return { exitCode: 0, stdout: keyscanOutput, stderr: "" };
};

// Owner-side routes, as the daemon wires them, with the scan runner above.
function ownerRoutes() {
  return new OwnerHostRoutes({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    state: dir,
    clients: { list: async () => [], dropHost: async () => 0 },
    runner,
    now: () => clockNow,
  });
}

// The setup port the daemon builds, over the real owner routes.
function setupPortFor(routes: OwnerHostRoutes, policy?: OwnerCall) {
  return ownerSetupPort({
    hosts: (path, input) => routes.owner(path, input, async () => undefined),
    policy: policy ?? (async () => undefined),
    scans: new ScanRecords(dir),
  });
}

async function makeBroker(routes: OwnerHostRoutes) {
  const key = await loadOrCreateDeviceKey(dir);
  const inventory: InventoryPort = {
    machine: async (host) => (host === "nas" ? nas : undefined),
    hosts: async () => ["nas"],
  };
  const executor: ExecutorPort = {
    run: async () => {
      throw new Error("no ssh in this test");
    },
    setup: setupPortFor(routes),
  };
  const broker = new Broker({
    store: new BrokerStore(dir),
    ledger: new NonceLedger(dir, () => clockNow),
    key,
    device: { id: "dev-test-0000000000", name: "test" },
    policy: new BasicPolicy(),
    inventory,
    executor,
    now: () => clockNow,
    approvalSurface: "http://127.0.0.1:7448/approvals",
  });
  await broker.init();
  return broker;
}

// Approves as the owner panel would (no password: a scan needs none).
async function approveScan(broker: Broker, id: string) {
  const op = await broker.operation(id);
  if (!op) throw new Error("no such operation");
  await broker.decide({
    operationId: id,
    fingerprint: op.fingerprint,
    decision: "approve-once",
    surface: "panel",
    stepUp: false,
  });
  await broker.settled();
  return broker.operation(id);
}

// Ask for an enrolment of the address and name used throughout.
const enrolRequest = (address = ADDRESS) => ({
  name: "new-box",
  address,
  user: "ops",
  access: "user",
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-scan-gate-"));
  inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, "version: 1\nmachines: {}\n");
  // The owner made the new machine's key in a private terminal.
  const keysDir = sessionPaths(inventoryPath).keys;
  await mkdir(keysDir, { recursive: true });
  await writeFile(join(keysDir, "new-box.pub"), `ssh-ed25519 ${BLOB}\n`);
  clockNow = T0;
  runnerCalls = [];
  keyscanOutput = `${ADDRESS} ssh-ed25519 ${BLOB}\n`;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("planning never contacts the network", () => {
  test("no request kind reaches the runner while it is planned", async () => {
    const routes = ownerRoutes();
    const broker = await makeBroker(routes);
    const requests: [string, unknown][] = [
      ["scan", { address: "192.0.2.90" }],
      ["probe", { name: "nas" }],
      ["access", { name: "nas", access: "observe" }],
      ["preset", { preset: "delegated" }],
      ["remove", { name: "nas" }],
      ["enroll", enrolRequest("192.0.2.91")],
    ];
    for (const [kind, raw] of requests) {
      const view = await broker
        .setupRequest(agent, kind, raw)
        .catch((error: Error) => error);
      // Enrolment without a scan is refused, and the refusal is also planning.
      if (kind === "enroll") expect(view).toBeInstanceOf(Error);
      else expect((view as { state: string }).state).toBe("awaiting-approval");
    }
    expect(runnerCalls).toEqual([]);
  });

  test("a recorded scan is read from the record, not from the address", async () => {
    const routes = ownerRoutes();
    const broker = await makeBroker(routes);
    const scan = await broker.setupRequest(agent, "scan", {
      address: ADDRESS,
    });
    expect(runnerCalls).toEqual([]);
    await approveScan(broker, scan.id);
    expect(runnerCalls.length).toBe(1);

    runnerCalls = [];
    const enrol = await broker.setupRequest(agent, "enroll", enrolRequest());
    expect(enrol.state).toBe("awaiting-approval");
    expect(runnerCalls).toEqual([]);
  });
});

describe("enrolment needs a recent, approved scan", () => {
  test("without any scan the request is refused, and the refusal says to scan first", async () => {
    const broker = await makeBroker(ownerRoutes());
    await expect(
      broker.setupRequest(agent, "enroll", enrolRequest()),
    ).rejects.toThrow("Ask for a scan of that address first (setup_scan)");
    expect(await broker.pending()).toEqual([]);
    expect(runnerCalls).toEqual([]);
  });

  test("a stale scan is refused; a scan 29 minutes old still counts", async () => {
    const routes = ownerRoutes();
    const broker = await makeBroker(routes);
    // Scan through the owner route, so the record is the one a real scan writes.
    await routes.owner(
      "/v1/owner/hosts/scan",
      { address: ADDRESS },
      async () => undefined,
    );
    clockNow = T0 + SCAN_FRESH_MS - 60_000;
    const fresh = await broker.setupRequest(agent, "enroll", enrolRequest());
    expect(fresh.state).toBe("awaiting-approval");

    clockNow = T0 + SCAN_FRESH_MS;
    await expect(
      broker.setupRequest(agent, "enroll", enrolRequest()),
    ).rejects.toThrow("more than 30 minutes old");
    expect(runnerCalls.length).toBe(1);
  });

  test("an approved agent scan lets the enrolment queue, and the card shows the scanned key", async () => {
    const broker = await makeBroker(ownerRoutes());
    const scan = await broker.setupRequest(agent, "scan", { address: ADDRESS });
    const done = await approveScan(broker, scan.id);
    expect(done?.state).toBe("succeeded");

    const view = await broker.setupRequest(agent, "enroll", enrolRequest());
    const op = await broker.operation(view.id);
    expect(op?.setup?.presented).toEqual([
      { type: "ssh-ed25519", fingerprint: FP },
    ]);
    expect(op?.setup?.confirmed).toBeUndefined();
  });

  test("a scan of another address does not allow this one", async () => {
    const routes = ownerRoutes();
    const broker = await makeBroker(routes);
    await routes.owner(
      "/v1/owner/hosts/scan",
      { address: "192.0.2.99" },
      async () => undefined,
    );
    await expect(
      broker.setupRequest(agent, "enroll", enrolRequest()),
    ).rejects.toThrow("Ask for a scan of that address first");
  });
});

describe("execution re-reads the key", () => {
  // Hosts stub for the setup port: the scan route answers with `scanKeys`, the
  // enrol route records what it was asked to pin.
  function executionPort(scanFingerprints: string[]) {
    const calls: { path: string; input: Record<string, unknown> }[] = [];
    const hosts: OwnerCall = async (path, input) => {
      calls.push({ path, input });
      if (path === "/v1/owner/hosts/scan")
        return {
          keys: scanFingerprints.map((fingerprint) => ({
            type: "ssh-ed25519",
            fingerprint,
          })),
        };
      if (path === "/v1/owner/hosts/enroll")
        return { name: "new-box", os: "Linux", access: "user" };
      return {};
    };
    const port = ownerSetupPort({
      hosts,
      policy: async () => undefined,
      scans: new ScanRecords(dir),
    });
    const request: SetupRun = {
      kind: "enroll",
      input: { ...enrolRequest() },
      confirmFingerprint: FP,
      presented: [{ type: "ssh-ed25519", fingerprint: FP }],
    };
    return { port, request, calls };
  }

  test("a key that changed since the card was shown is refused and nothing is added", async () => {
    const { port, request, calls } = executionPort([OTHER_FP]);
    const result = await port.run(request);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("different key");
    expect(calls.map((call) => call.path)).toEqual(["/v1/owner/hosts/scan"]);
  });

  test("a machine that shows an extra key is refused too", async () => {
    const { port, request, calls } = executionPort([FP, OTHER_FP]);
    const result = await port.run(request);
    expect(result.exitCode).toBe(1);
    expect(calls.map((call) => call.path)).not.toContain(
      "/v1/owner/hosts/enroll",
    );
  });

  test("the unchanged key reaches the enrol route with the typed fingerprint", async () => {
    const { port, request, calls } = executionPort([FP]);
    const result = await port.run(request);
    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/owner/hosts/scan",
      "/v1/owner/hosts/enroll",
    ]);
    expect(calls[1]?.input.fingerprint).toBe(FP);
  });
});
