// Agent setup requests through the broker (0.3 acceptance): each kind is submitted,
// queued for the owner, approved and executed against a stub setup port. Nothing
// reaches a real machine or an AI provider. Refusals are checked too: the agent
// cannot supply a password or a fingerprint confirmation, the policy, rules and
// "remember" cannot approve, and hosts outside the grant are refused.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "../src/approvals/ledger";
import { agentMethod } from "../src/broker/agent-methods";
import { BasicPolicy } from "../src/broker/basic-policy";
import { Broker } from "../src/broker/engine";
import { BrokerStore } from "../src/broker/store";
import type {
  ExecutorPort,
  InventoryPort,
  PresentedKey,
  SetupPort,
  SetupRun,
} from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import type { Machine } from "../src/types";

setDefaultTimeout(60_000);

const FP_PRESENTED = `SHA256:${"A".repeat(43)}`;
const FP_OTHER = `SHA256:${"B".repeat(43)}`;

let dir: string;
const clock = 1_800_000_000_000;
const now = () => clock;
const agent: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["nas"],
};
const machine = (access: string, user = "ops"): Machine =>
  ({
    description: "Synthetic test machine",
    transport: "ssh",
    access,
    address: "192.0.2.20",
    user,
    ssh_alias: "nas",
  }) as unknown as Machine;

let machines: Record<string, Machine>;
let runs: SetupRun[];
let evaluations: number;
let remembered: number;
let presented: PresentedKey[];
let keysReady: Set<string>;
// When the owner's last scan ran (undefined: no scan on record).
let scannedAt: number | undefined;

// A policy that counts every call it is asked to make. Setup requests must never
// reach it: no evaluation, no remembered rule.
class SpyPolicy extends BasicPolicy {
  override async evaluate(
    req: Parameters<BasicPolicy["evaluate"]>[0],
    ctx: Parameters<BasicPolicy["evaluate"]>[1],
  ) {
    evaluations += 1;
    return super.evaluate(req, ctx);
  }
  async remember(): Promise<string> {
    remembered += 1;
    return "rule-should-not-exist";
  }
}

// Enrolment reads the scan record (never the network): the keys of the last scan.
const setupPort: SetupPort = {
  lastScan: async (address, port) =>
    scannedAt === undefined
      ? undefined
      : { address, port, at: scannedAt, keys: presented },
  keyReady: async (name) => keysReady.has(name),
  run: async (request) => {
    runs.push(request);
    return { exitCode: 0, stdout: `ran ${request.kind}`, stderr: "" };
  },
};

// `null` builds a broker without the setup port (the owner routes not wired).
async function makeBroker(setup: SetupPort | null = setupPort) {
  const key = await loadOrCreateDeviceKey(dir);
  const inventory: InventoryPort = {
    machine: async (host) => machines[host],
    hosts: async () => Object.keys(machines),
  };
  const executor: ExecutorPort = {
    run: async () => {
      throw new Error("no ssh in this test");
    },
    ...(setup ? { setup } : {}),
  };
  const broker = new Broker({
    store: new BrokerStore(dir),
    ledger: new NonceLedger(dir, now),
    key,
    device: { id: "dev-test-0000000000", name: "test" },
    policy: new SpyPolicy(),
    inventory,
    executor,
    now,
    approvalSurface: "http://127.0.0.1:7448/approvals",
  });
  await broker.init();
  return broker;
}

// Approves as the owner panel would: the decision names the plan's fingerprint.
async function approve(
  broker: Broker,
  id: string,
  options: { password?: boolean; confirm?: string; decision?: string } = {},
) {
  const op = await broker.operation(id);
  if (!op) throw new Error("no such operation");
  const result = await broker.decide({
    operationId: id,
    fingerprint: op.fingerprint,
    decision: (options.decision ?? "approve-once") as "approve-once",
    surface: "panel",
    stepUp: options.password === true,
    ...(options.confirm === undefined
      ? {}
      : { confirmFingerprint: options.confirm }),
  });
  // decide answers before a dispatch finishes; the final state is read after it.
  await broker.settled();
  return { ...result, final: await broker.operation(id) };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-setup-requests-"));
  machines = { nas: machine("user"), pve: machine("user") };
  runs = [];
  evaluations = 0;
  remembered = 0;
  presented = [{ type: "ssh-ed25519", fingerprint: FP_PRESENTED }];
  keysReady = new Set(["new-box"]);
  scannedAt = clock;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("each request kind: submit, queue, approve, execute", () => {
  test("scan needs no password and runs once approved", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "scan", {
      address: "192.0.2.44",
    });
    expect(view.state).toBe("awaiting-approval");
    const op = await broker.operation(view.id);
    expect(op?.decision.humanOnly).toBe(true);
    expect(op?.decision.stepUp).toBe(false);
    expect(op?.ownerOnly).toBe(true);
    const done = await approve(broker, view.id);
    expect(done.final?.state).toBe("succeeded");
    expect(runs.map((run) => run.kind)).toEqual(["scan"]);
    expect(evaluations).toBe(0);
  });

  test("probe of a granted machine needs no password", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "probe", { name: "nas" });
    expect((await broker.operation(view.id))?.decision.stepUp).toBe(false);
    const done = await approve(broker, view.id);
    expect(done.final?.state).toBe("succeeded");
    expect(runs[0]?.input).toEqual({ name: "nas" });
  });

  test("adding a machine needs the password and the typed fingerprint", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "enroll", {
      name: "new-box",
      address: "192.0.2.45",
      user: "ops",
      access: "user",
      narrative: "The owner asked for a new box",
    });
    const op = await broker.operation(view.id);
    expect(op?.decision.stepUp).toBe(true);
    expect(op?.setup?.presented).toEqual(presented);
    // The card's presented key is part of the plan, and the agent never sets it.
    expect(op?.setup?.confirmed).toBeUndefined();

    await expect(approve(broker, view.id, { password: true })).rejects.toThrow(
      "Type the fingerprint",
    );
    await expect(
      approve(broker, view.id, {
        password: true,
        confirm: FP_OTHER,
      }),
    ).rejects.toThrow("does not match");
    await expect(
      approve(broker, view.id, { confirm: FP_PRESENTED }),
    ).rejects.toThrow("confirm your identity");
    // Refused attempts changed nothing: the request still waits for the owner.
    expect((await broker.operation(view.id))?.state).toBe("awaiting-approval");

    const done = await approve(broker, view.id, {
      password: true,
      confirm: FP_PRESENTED,
    });
    expect(done.final?.state).toBe("succeeded");
    expect(runs[0]?.kind).toBe("enroll");
    expect(runs[0]?.confirmFingerprint).toBe(FP_PRESENTED);
  });

  test("changing access needs the password; full access is the hard-gated top tier", async () => {
    const broker = await makeBroker();
    const lower = await broker.setupRequest(agent, "access", {
      name: "nas",
      access: "observe",
    });
    expect((await broker.operation(lower.id))?.risk).toBe("R3");
    expect((await broker.operation(lower.id))?.decision.stepUp).toBe(true);
    await expect(approve(broker, lower.id)).rejects.toThrow(
      "confirm your identity",
    );
    const done = await approve(broker, lower.id, { password: true });
    expect(done.final?.state).toBe("succeeded");
    expect(runs[0]?.input).toEqual({ name: "nas", access: "observe" });

    const top = await broker.setupRequest(agent, "access", {
      name: "nas",
      access: "full",
    });
    expect((await broker.operation(top.id))?.risk).toBe("R4");
  });

  test("the permission setting needs the password", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "preset", {
      preset: "delegated",
    });
    expect((await broker.operation(view.id))?.decision.stepUp).toBe(true);
    await expect(approve(broker, view.id)).rejects.toThrow(
      "confirm your identity",
    );
    const done = await approve(broker, view.id, { password: true });
    expect(done.final?.state).toBe("succeeded");
    expect(runs[0]?.input).toEqual({ preset: "delegated" });
  });

  test("removing a machine is destructive and needs the password", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "remove", { name: "nas" });
    const op = await broker.operation(view.id);
    expect(op?.risk).toBe("R4");
    expect(op?.classification).toBe("destructive");
    const done = await approve(broker, view.id, { password: true });
    expect(done.final?.state).toBe("succeeded");
    expect(runs[0]?.kind).toBe("remove");
  });

  test("a denied request never runs", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "remove", { name: "nas" });
    const done = await approve(broker, view.id, { decision: "deny-once" });
    expect(done.final?.state).toBe("denied");
    expect(runs).toEqual([]);
  });

  test("a failing route ends the request as failed, with a plain reason", async () => {
    const failing: SetupPort = {
      ...setupPort,
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "The change did not finish.",
      }),
    };
    const broker = await makeBroker(failing);
    const view = await broker.setupRequest(agent, "probe", { name: "nas" });
    const done = await approve(broker, view.id);
    expect(done.final?.state).toBe("failed");
    expect(done.final?.result?.stderr).toBe("The change did not finish.");
  });
});

describe("refusals", () => {
  test("the agent cannot supply a password, a fingerprint confirmation or a key", async () => {
    const broker = await makeBroker();
    await expect(
      broker.setupRequest(agent, "enroll", {
        name: "new-box",
        address: "192.0.2.45",
        user: "ops",
        access: "user",
        fingerprint: FP_PRESENTED,
      }),
    ).rejects.toThrow("Unknown field: fingerprint");
    await expect(
      broker.setupRequest(agent, "enroll", {
        name: "new-box",
        address: "192.0.2.45",
        user: "ops",
        access: "user",
        confirmFingerprint: FP_PRESENTED,
      }),
    ).rejects.toThrow("Unknown field: confirmFingerprint");
    await expect(
      broker.setupRequest(agent, "preset", {
        preset: "delegated",
        password: "hunter2",
      }),
    ).rejects.toThrow("Unknown field: password");
    await expect(
      broker.setupRequest(agent, "remove", { name: "nas", key: "x" }),
    ).rejects.toThrow("Unknown field: key");
  });

  test("an approval that names a fingerprint must match one the machine presented", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "enroll", {
      name: "new-box",
      address: "192.0.2.45",
      user: "ops",
      access: "user",
    });
    await expect(
      approve(broker, view.id, { password: true, confirm: "SHA256:short" }),
    ).rejects.toThrow("does not match");
    expect(runs).toEqual([]);
  });

  test("the AI helper, rules and remember cannot approve a setup request", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "enroll", {
      name: "new-box",
      address: "192.0.2.45",
      user: "ops",
      access: "user",
    });
    await expect(
      approve(broker, view.id, {
        password: true,
        confirm: FP_PRESENTED,
        decision: "approve-remember",
      }),
    ).rejects.toThrow("cannot be remembered");
    const scan = await broker.setupRequest(agent, "scan", {
      address: "192.0.2.44",
    });
    const denied = await approve(broker, scan.id, {
      decision: "deny-remember",
    });
    expect(denied.operation.state).toBe("denied");
    expect(remembered).toBe(0);
    expect(evaluations).toBe(0);
    expect(runs).toEqual([]);
  });

  test("hosts outside the grant are refused, the same way an unknown host is", async () => {
    const broker = await makeBroker();
    for (const name of ["pve", "missing-host"])
      await expect(
        broker.setupRequest(agent, "probe", { name }),
      ).rejects.toThrow("Host is not in this client's grants");
    await expect(
      broker.setupRequest(agent, "remove", { name: "pve" }),
    ).rejects.toThrow("Host is not in this client's grants");
  });

  test("a client without the plan scope cannot request setup changes", async () => {
    const broker = await makeBroker();
    const readOnly = { ...agent, scopes: ["status:read"] } as ClientIdentity;
    await expect(
      broker.setupRequest(readOnly, "scan", { address: "192.0.2.44" }),
    ).rejects.toThrow("Host is not in this client's grants");
  });

  test("an enrolment cannot take a name in use, a machine with no key, or an address with no key", async () => {
    const broker = await makeBroker();
    await expect(
      broker.setupRequest(agent, "enroll", {
        name: "nas",
        address: "192.0.2.45",
        user: "ops",
        access: "user",
      }),
    ).rejects.toThrow("already in use");
    await expect(
      broker.setupRequest(agent, "enroll", {
        name: "no-key",
        address: "192.0.2.45",
        user: "ops",
        access: "user",
      }),
    ).rejects.toThrow("Request setup_create_key");
    presented = [];
    await expect(
      broker.setupRequest(agent, "enroll", {
        name: "new-box",
        address: "192.0.2.45",
        user: "ops",
        access: "user",
      }),
    ).rejects.toThrow("presented no SSH key");
  });

  test("a sudo-approved level is set by the owner, and an unchanged level is refused", async () => {
    const broker = await makeBroker();
    await expect(
      broker.setupRequest(agent, "access", {
        name: "nas",
        access: "sudo-approved",
      }),
    ).rejects.toThrow("Ask for look only");
    await expect(
      broker.setupRequest(agent, "access", { name: "nas", access: "user" }),
    ).rejects.toThrow("already has this access level");
  });

  test("the root account keeps full access", async () => {
    machines.nas = machine("full", "root");
    const broker = await makeBroker();
    await expect(
      broker.setupRequest(agent, "access", { name: "nas", access: "user" }),
    ).rejects.toThrow("root account always has full access");
  });

  test("an unknown request kind is refused", async () => {
    const broker = await makeBroker();
    await expect(
      broker.setupRequest(agent, "backup-restore", {}),
    ).rejects.toThrow("Unknown setup request");
  });

  test("a broker without the setup port refuses requests before anything is queued", async () => {
    const broker = await makeBroker(null);
    await expect(
      broker.setupRequest(agent, "scan", { address: "192.0.2.44" }),
    ).rejects.toThrow("not available on this broker");
    expect(await broker.pending()).toEqual([]);
  });

  test("a machine change after the plan stops the request", async () => {
    const broker = await makeBroker();
    const view = await broker.setupRequest(agent, "access", {
      name: "nas",
      access: "observe",
    });
    machines.nas = machine("full");
    const done = await approve(broker, view.id, { password: true });
    expect(done.final?.state).toBe("failed");
    expect(done.operation.reason).toBe("plan-changed");
    expect(runs).toEqual([]);
  });
});

describe("the agent route", () => {
  test("a setup request is an agent route; the owner route stays owner-only", async () => {
    const broker = await makeBroker();
    const view = (await agentMethod(
      broker,
      "/v1/setup/request/scan",
      { address: "192.0.2.44", narrative: "check this address" },
      agent,
    )) as { id: string; state: string };
    expect(view.state).toBe("awaiting-approval");
    const op = await broker.operation(view.id);
    expect(op?.narrative).toBe("check this address");
    await expect(
      agentMethod(broker, "/v1/setup/request/nope", {}, agent),
    ).rejects.toThrow("Unknown setup request");
  });
});
