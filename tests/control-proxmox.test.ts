import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import { TOOLS } from "../src/control/mcp";
import type { ClientIdentity } from "../src/control/types";
import {
  HomectlError,
  type ProcessResult,
  type ProcessSpec,
} from "../src/types";

// Synthetic inventory: a full-access keepassxc host with a Proxmox provider.
// Node pve-test, VMIDs 9001–9010. No host is contacted: the runner is a fake.
const INVENTORY = `version: 1
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
  plain-host:
    description: Synthetic local host without a provider
    transport: local
    access: user
providers:
  pve-test:
    type: proxmox
    host: pve-host
    node: pve-test
    vmid_range: [9001, 9010]
    protected_vmids: [9009]
    storages: [local-test]
    templates: [debian-12-standard_12.2-1_amd64.tar.zst]
`;
// Same inventory without vmid_range: changes must be refused.
const INVENTORY_NO_RANGE = INVENTORY.replace(
  "    vmid_range: [9001, 9010]\n",
  "",
);
if (INVENTORY_NO_RANGE === INVENTORY) throw new Error("range line not found");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// Everything the runner would have sent, flattened to one searchable string.
function sent(spec: ProcessSpec): string {
  return `${JSON.stringify(spec.argv)} ${spec.stdin ?? ""}`;
}

async function fixture(inventory: string = INVENTORY) {
  const dir = await mkdtemp(join(tmpdir(), "homectl-proxmox-"));
  dirs.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, inventory);
  const runs: ProcessSpec[] = [];
  const runner = async (spec: ProcessSpec): Promise<ProcessResult> => {
    runs.push(spec);
    const text = sent(spec);
    const stdout =
      text.includes("qm") && text.includes("list")
        ? "VMID NAME STATUS\n9001 sample-vm running\n"
        : "ok\n";
    return { exitCode: 0, stdout, stderr: "" };
  };
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory: join(dir, "control-plane"),
    runner,
  });
  await plane.init();
  const codexToken = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "inspect:read", "status:read"],
    hosts: ["pve-host", "plain-host"],
  });
  const hermesToken = await plane.createClient({
    id: "hermes-admin",
    name: "Hermes Admin",
    scopes: ["approve:decide", "status:read"],
    hosts: ["pve-host", "plain-host"],
  });
  const codex = (await plane.authenticate(
    codexToken.token as string,
  )) as ClientIdentity;
  const hermes = (await plane.authenticate(
    hermesToken.token as string,
  )) as ClientIdentity;
  return { plane, runs, codex, hermes };
}

function proxmoxPlan(
  f: Awaited<ReturnType<typeof fixture>>,
  fields: Record<string, unknown>,
) {
  return f.plane.request(
    { kind: "client", client: f.codex },
    { op: "proxmox-plan", host: "pve-host", ...fields },
  ) as Promise<{
    operationId: string;
    fingerprint: string;
    impact: string;
    classification: string;
    needsApproval: boolean;
    state: string;
  }>;
}

async function refusedWith(
  promise: Promise<unknown>,
  code: number,
): Promise<boolean> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HomectlError && error.code === code;
  }
  return false;
}

describe("Proxmox guest plans through the control plane", () => {
  test("inspection runs without approval and returns the recorded qm output", async () => {
    const f = await fixture();
    const op = await proxmoxPlan(f, { kind: "qemu", action: "list" });
    expect(op.classification).toBe("inspect");
    expect(op.needsApproval).toBe(false);
    const ran = (await f.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: op.operationId },
    )) as { operation: { state: string } };
    expect(ran.operation.state).toBe("succeeded");
    expect(f.runs.some((spec) => sent(spec).includes("qm"))).toBe(true);
  });

  test("a start is a mutation: it needs a second client's approval, runs the exact argv with sudo, and carries the friendly label", async () => {
    const f = await fixture();
    const op = await proxmoxPlan(f, {
      kind: "qemu",
      action: "start",
      vmid: 9003,
      name: "sample-vm",
    });
    expect(op.classification).toBe("mutation");
    expect(op.needsApproval).toBe(true);
    expect(op.impact).toBe("Start VM 9003 (sample-vm)");
    const view = (await f.plane.listOperations({ all: true })).find(
      (o) => o.operationId === op.operationId,
    );
    expect(view?.impact).toBe("Start VM 9003 (sample-vm)");
    expect(view?.argv).toEqual(["sudo", "-n", "qm", "start", "9003"]);
    await f.plane.request(
      { kind: "client", client: f.hermes },
      {
        op: "approve",
        operationId: op.operationId,
        fingerprint: op.fingerprint,
        decision: "approve",
      },
    );
    const ran = (await f.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: op.operationId },
    )) as { operation: { state: string } };
    expect(ran.operation.state).toBe("succeeded");
    const started = f.runs.find((spec) => sent(spec).includes("9003"));
    expect(started).toBeDefined();
    // The remote command is the exact planned argv, shell-quoted.
    expect(sent(started as ProcessSpec)).toContain(
      "'sudo' '-n' 'qm' 'start' '9003'",
    );
  });

  test("destroy is destructive and needs approval", async () => {
    const f = await fixture();
    const op = await proxmoxPlan(f, {
      kind: "qemu",
      action: "destroy",
      vmid: 9007,
      name: "sample-old",
    });
    expect(op.classification).toBe("destructive");
    expect(op.needsApproval).toBe(true);
    expect(op.impact).toBe("Destroy VM 9007 (sample-old) and purge its disks");
    expect(op.state).toBe("pending");
  });

  test("typed refusals: VMID out of range, template and storage not allowed, and no node field", async () => {
    const f = await fixture();
    expect(
      await refusedWith(
        proxmoxPlan(f, { kind: "qemu", action: "start", vmid: 9011 }),
        2,
      ),
    ).toBe(true);
    expect(
      await refusedWith(
        proxmoxPlan(f, {
          kind: "qemu",
          action: "clone",
          vmid: 9005,
          template: 9001,
          name: "sample-clone",
          storage: "tank",
        }),
        2,
      ),
    ).toBe(true);
    expect(
      await refusedWith(
        proxmoxPlan(f, {
          kind: "lxc",
          action: "create",
          vmid: 9006,
          name: "sample-ct",
          template: "evil.tar.gz",
          storage: "local-test",
          memory_mb: 512,
          cores: 1,
          disk_gb: 4,
          bridge: "vmbr0",
          address: "dhcp",
        }),
        2,
      ),
    ).toBe(true);
    expect(
      await refusedWith(
        f.plane.request(
          { kind: "client", client: f.codex },
          {
            op: "proxmox-plan",
            host: "pve-host",
            kind: "qemu",
            action: "list",
            node: "other",
          },
        ),
        2,
      ),
    ).toBe(true);
  });

  test("a host without a Proxmox provider is refused for guest plans", async () => {
    const f = await fixture();
    expect(
      await refusedWith(
        f.plane.request(
          { kind: "client", client: f.codex },
          {
            op: "proxmox-plan",
            host: "plain-host",
            kind: "qemu",
            action: "list",
          },
        ),
        3,
      ),
    ).toBe(true);
  });

  test("a generic plan can never carry a free-form qm or pct argv", async () => {
    const f = await fixture();
    expect(
      await refusedWith(
        f.plane.request(
          { kind: "client", client: f.codex },
          {
            op: "plan",
            host: "pve-host",
            argv: ["sudo", "-n", "qm", "start", "9003"],
          },
        ),
        3,
      ),
    ).toBe(true);
    expect(
      await refusedWith(
        f.plane.request(
          { kind: "client", client: f.codex },
          { op: "plan", host: "pve-host", argv: ["qm", "list"] },
        ),
        3,
      ),
    ).toBe(true);
  });

  test("the MCP surface offers the typed tool, with no node or argv field", () => {
    const tool = TOOLS.find((t) => t.name === "homectl_proxmox_plan");
    expect(tool?.op).toBe("proxmox-plan");
    expect(tool?.scope).toBe("plan:create");
    const properties = Object.keys(
      (tool?.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(properties).not.toContain("argv");
    expect(properties).not.toContain("node");
    expect(properties).toContain("vmid");
    expect(properties).toContain("action");
  });
});

async function refusalMessage(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HomectlError ? error.message : undefined;
  }
  return undefined;
}

describe("VMID range and destroy guards through the control plane", () => {
  test("changes need an explicit vmid_range; inspection still runs", async () => {
    const f = await fixture(INVENTORY_NO_RANGE);
    expect(
      await refusalMessage(
        proxmoxPlan(f, { kind: "qemu", action: "start", vmid: 9003 }),
      ),
    ).toBe(
      "Set vmid_range for pve-host in the inventory before planning VM changes",
    );
    const listed = await proxmoxPlan(f, { kind: "qemu", action: "list" });
    expect(listed.classification).toBe("inspect");
  });

  test("destroy refuses a protected VMID and an unnamed guest", async () => {
    const f = await fixture();
    expect(
      await refusalMessage(
        proxmoxPlan(f, {
          kind: "qemu",
          action: "destroy",
          vmid: 9009,
          name: "sample-old",
        }),
      ),
    ).toBe(
      "VM 9009 is listed in protected_vmids for pve-host and cannot be destroyed",
    );
    expect(
      await refusalMessage(
        proxmoxPlan(f, { kind: "qemu", action: "destroy", vmid: 9007 }),
      ),
    ).toBe(
      "Destroy needs the guest name: lowercase letters, digits and dashes",
    );
  });

  test("the queued destroy shows the guest name in the impact the panel confirms", async () => {
    const f = await fixture();
    const op = await proxmoxPlan(f, {
      kind: "qemu",
      action: "destroy",
      vmid: 9007,
      name: "sample-old",
    });
    const view = (await f.plane.listOperations({ all: true })).find(
      (o) => o.operationId === op.operationId,
    );
    expect(view?.impact).toBe(
      "Destroy VM 9007 (sample-old) and purge its disks",
    );
  });
});
