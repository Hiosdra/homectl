import { describe, expect, test } from "bun:test";
import { planExecution } from "../src/policies";
import {
  buildProxmoxPlan,
  catalogueClass,
  isGuestArgv,
  type ProxmoxFacts,
  type ProxmoxInput,
  providerFacts,
} from "../src/proxmox/catalogue";
import { HomectlError, type Machine } from "../src/types";

// Synthetic facts only: node pve-test, VMIDs 9001–9010.
const facts: ProxmoxFacts = {
  host: "pve-host",
  node: "pve-test",
  vmidMin: 9001,
  vmidMax: 9010,
  vmidRangeSet: true,
  protectedVmids: [9009],
  storages: ["local-test"],
  templates: ["debian-12-standard_12.2-1_amd64.tar.zst"],
};
const machine: Machine = {
  description: "Synthetic Proxmox host",
  transport: "ssh",
  access: "full",
  user: "ops",
  ssh_alias: "pve-host",
  address: "192.0.2.10",
  auth: {
    type: "keepassxc",
    entry: "homectl-pve-host",
    socket: "/tmp/homectl-synthetic/agent.sock",
    public_key: "/tmp/homectl-synthetic/pve-host.pub",
  },
};

function refused(fn: () => unknown, code = 2): boolean {
  try {
    fn();
  } catch (error) {
    return error instanceof HomectlError && error.code === code;
  }
  return false;
}

describe("catalogue argv and labels", () => {
  test("every action builds one exact argv on the provider's node, with a friendly label", () => {
    expect(buildProxmoxPlan({ kind: "qemu", action: "list" }, facts)).toEqual({
      argv: ["qm", "list"],
      label: "List VMs on pve-test",
      classification: "inspect",
    });
    expect(
      buildProxmoxPlan({ kind: "lxc", action: "list" }, facts).argv,
    ).toEqual(["pct", "list"]);
    expect(
      buildProxmoxPlan({ kind: "qemu", action: "status", vmid: 9003 }, facts)
        .argv,
    ).toEqual(["qm", "status", "9003"]);
    expect(
      buildProxmoxPlan({ kind: "lxc", action: "config", vmid: 9004 }, facts)
        .argv,
    ).toEqual(["pct", "config", "9004"]);
    const start = buildProxmoxPlan(
      { kind: "qemu", action: "start", vmid: 9003, name: "sample-vm" },
      facts,
    );
    expect(start).toEqual({
      argv: ["qm", "start", "9003"],
      label: "Start VM 9003 (sample-vm)",
      classification: "mutation",
    });
    expect(
      buildProxmoxPlan({ kind: "lxc", action: "stop", vmid: 9004 }, facts).argv,
    ).toEqual(["pct", "stop", "9004"]);
    expect(
      buildProxmoxPlan({ kind: "qemu", action: "reboot", vmid: 9003 }, facts)
        .argv,
    ).toEqual(["qm", "reboot", "9003"]);
    expect(
      buildProxmoxPlan({ kind: "qemu", action: "shutdown", vmid: 9003 }, facts)
        .argv,
    ).toEqual(["qm", "shutdown", "9003", "--timeout", "120"]);
    expect(
      buildProxmoxPlan(
        { kind: "lxc", action: "shutdown", vmid: 9004, timeout_s: 30 },
        facts,
      ).argv,
    ).toEqual(["pct", "shutdown", "9004", "--timeout", "30"]);
  });

  test("clone and LXC create build exact argv with allowlisted storage and template", () => {
    const clone = buildProxmoxPlan(
      {
        kind: "qemu",
        action: "clone",
        vmid: 9005,
        template: 9001,
        name: "sample-clone",
        storage: "local-test",
      },
      facts,
    );
    expect(clone.argv).toEqual([
      "qm",
      "clone",
      "9001",
      "9005",
      "--name",
      "sample-clone",
      "--full",
      "1",
      "--storage",
      "local-test",
    ]);
    expect(clone.classification).toBe("mutation");
    const create = buildProxmoxPlan(
      {
        kind: "lxc",
        action: "create",
        vmid: 9006,
        name: "sample-ct",
        template: "debian-12-standard_12.2-1_amd64.tar.zst",
        storage: "local-test",
        memory_mb: 1024,
        cores: 2,
        disk_gb: 8,
        bridge: "vmbr0",
        address: "dhcp",
      },
      facts,
    );
    expect(create.argv).toEqual([
      "pct",
      "create",
      "9006",
      "local-test:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst",
      "--hostname",
      "sample-ct",
      "--unprivileged",
      "1",
      "--memory",
      "1024",
      "--cores",
      "2",
      "--rootfs",
      "local-test:8",
      "--net0",
      "name=eth0,bridge=vmbr0,ip=dhcp",
    ]);
    const staticCt = buildProxmoxPlan(
      {
        kind: "lxc",
        action: "create",
        vmid: 9006,
        name: "sample-ct",
        template: "debian-12-standard_12.2-1_amd64.tar.zst",
        storage: "local-test",
        memory_mb: 512,
        cores: 1,
        disk_gb: 4,
        bridge: "vmbr1",
        address: "192.0.2.50",
        cidr: 24,
        gateway: "192.0.2.1",
      },
      facts,
    );
    expect(staticCt.argv.at(-1)).toBe(
      "name=eth0,bridge=vmbr1,ip=192.0.2.50/24,gw=192.0.2.1",
    );
  });

  test("destroy is destructive and always purges through the explicit flag", () => {
    const destroy = buildProxmoxPlan(
      { kind: "qemu", action: "destroy", vmid: 9007, name: "sample-old" },
      facts,
    );
    expect(destroy.argv).toEqual(["qm", "destroy", "9007", "--purge"]);
    expect(destroy.classification).toBe("destructive");
    expect(destroy.label).toBe(
      "Destroy VM 9007 (sample-old) and purge its disks",
    );
  });

  test("the node comes from the provider, never from the request", () => {
    const withNode = {
      kind: "qemu",
      action: "list",
      node: "other",
    } as unknown as Parameters<typeof buildProxmoxPlan>[0];
    expect(buildProxmoxPlan(withNode, facts).argv).toEqual(["qm", "list"]);
    expect(facts.node).toBe("pve-test");
    expect(
      providerFacts({ type: "proxmox", host: "pve-host", node: "pve-test" })
        .vmidMin,
    ).toBe(100);
  });
});

describe("catalogue refusals", () => {
  test("VMIDs outside the provider range, and a template VMID equal to the target", () => {
    expect(
      refused(() =>
        buildProxmoxPlan({ kind: "qemu", action: "start", vmid: 9011 }, facts),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan({ kind: "qemu", action: "start", vmid: 42 }, facts),
      ),
    ).toBe(true);
    expect(
      refused(() => buildProxmoxPlan({ kind: "qemu", action: "start" }, facts)),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "qemu",
            action: "clone",
            vmid: 9002,
            template: 9002,
            name: "x-y",
          },
          facts,
        ),
      ),
    ).toBe(true);
  });

  test("storages and templates must be in the provider's allowlists", () => {
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "qemu",
            action: "clone",
            vmid: 9005,
            template: 9001,
            name: "x-y",
            storage: "tank",
          },
          facts,
        ),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "lxc",
            action: "create",
            vmid: 9006,
            name: "x-y",
            template: "evil.tar.gz",
            storage: "local-test",
            memory_mb: 512,
            cores: 1,
            disk_gb: 4,
            bridge: "vmbr0",
            address: "dhcp",
          },
          facts,
        ),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "lxc",
            action: "create",
            vmid: 9006,
            name: "x-y",
            template: "debian-12-standard_12.2-1_amd64.tar.zst",
            storage: "tank",
            memory_mb: 512,
            cores: 1,
            disk_gb: 4,
            bridge: "vmbr0",
            address: "dhcp",
          },
          facts,
        ),
      ),
    ).toBe(true);
  });

  test("names, bridges, addresses and numeric bounds are checked", () => {
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "qemu",
            action: "clone",
            vmid: 9005,
            template: 9001,
            name: "Bad Name",
          },
          facts,
        ),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "lxc",
            action: "create",
            vmid: 9006,
            name: "x-y",
            template: "debian-12-standard_12.2-1_amd64.tar.zst",
            storage: "local-test",
            memory_mb: 64,
            cores: 1,
            disk_gb: 4,
            bridge: "vmbr0",
            address: "dhcp",
          },
          facts,
        ),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "lxc",
            action: "create",
            vmid: 9006,
            name: "x-y",
            template: "debian-12-standard_12.2-1_amd64.tar.zst",
            storage: "local-test",
            memory_mb: 512,
            cores: 1,
            disk_gb: 4,
            bridge: "eth0; rm",
            address: "dhcp",
          },
          facts,
        ),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "lxc",
            action: "create",
            vmid: 9006,
            name: "x-y",
            template: "debian-12-standard_12.2-1_amd64.tar.zst",
            storage: "local-test",
            memory_mb: 512,
            cores: 1,
            disk_gb: 4,
            bridge: "vmbr0",
            address: "192.0.2.50",
          },
          facts,
        ),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          { kind: "qemu", action: "shutdown", vmid: 9003, timeout_s: 5 },
          facts,
        ),
      ),
    ).toBe(true);
  });

  test("clone is QEMU only and create is LXC only", () => {
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "lxc",
            action: "clone",
            vmid: 9005,
            template: 9001,
            name: "x-y",
          },
          facts,
        ),
      ),
    ).toBe(true);
    expect(
      refused(() =>
        buildProxmoxPlan(
          {
            kind: "qemu",
            action: "create",
            vmid: 9006,
            name: "x-y",
            template: "debian-12-standard_12.2-1_amd64.tar.zst",
            storage: "local-test",
            memory_mb: 512,
            cores: 1,
            disk_gb: 4,
            bridge: "vmbr0",
            address: "dhcp",
          },
          facts,
        ),
      ),
    ).toBe(true);
  });
});

describe("the policy layer accepts only exact catalogue forms", () => {
  test("catalogueClass recognises each form and nothing else", () => {
    expect(catalogueClass(["qm", "list"])).toBe("inspect");
    expect(catalogueClass(["pct", "status", "9004"])).toBe("inspect");
    expect(catalogueClass(["qm", "start", "9003"])).toBe("mutation");
    expect(catalogueClass(["qm", "shutdown", "9003", "--timeout", "120"])).toBe(
      "mutation",
    );
    expect(catalogueClass(["qm", "destroy", "9007", "--purge"])).toBe(
      "destructive",
    );
    expect(catalogueClass(["qm", "destroy", "9007"])).toBeUndefined();
    expect(
      catalogueClass(["qm", "set", "9003", "--memory", "4096"]),
    ).toBeUndefined();
    expect(
      catalogueClass(["qm", "start", "9003", "--skiplock"]),
    ).toBeUndefined();
    expect(catalogueClass(["pct", "exec", "9004", "--", "sh"])).toBeUndefined();
    expect(
      catalogueClass([
        "pct",
        "create",
        "9006",
        "local-test:vztmpl/x.tar.gz",
        "--unprivileged",
        "0",
      ]),
    ).toBeUndefined();
    expect(
      catalogueClass([
        "qm",
        "clone",
        "9001",
        "9005",
        "--name",
        "x-y",
        "--full",
        "1",
        "--storage",
        "tank",
      ]),
    ).toBe("mutation");
    expect(isGuestArgv(["qm", "list"])).toBe(true);
    expect(isGuestArgv(["/usr/sbin/pct", "list"])).toBe(true);
    expect(isGuestArgv(["systemctl", "status"])).toBe(false);
  });

  test("a generic plan refuses qm and pct; a catalogue plan accepts exactly its form", () => {
    const generic = (argv: string[]) => () =>
      planExecution("pve-host", machine, argv, "x");
    expect(refused(generic(["qm", "start", "9003"]), 3)).toBe(true);
    expect(
      refused(generic(["sudo", "-n", "qm", "destroy", "9007", "--purge"]), 3),
    ).toBe(true);
    const plan = planExecution(
      "pve-host",
      machine,
      ["sudo", "-n", "qm", "start", "9003"],
      "Start VM 9003",
      { catalogue: true },
    );
    expect(plan.classification).toBe("mutation");
    // The exec policy flags only destructive and opaque plans; the control plane adds approval for every mutation.
    expect(plan.needsApproval).toBe(false);
    expect(
      refused(
        () =>
          planExecution("pve-host", machine, ["qm", "set", "9003"], "x", {
            catalogue: true,
          }),
        3,
      ),
    ).toBe(true);
    const list = planExecution(
      "pve-host",
      machine,
      ["sudo", "-n", "qm", "list"],
      "List",
      { catalogue: true },
    );
    expect(list.needsApproval).toBe(false);
  });
});

function messageOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof HomectlError ? error.message : undefined;
  }
  return undefined;
}

describe("VMID range and destroy guards", () => {
  const unset: ProxmoxFacts = { ...facts, vmidRangeSet: false };

  test("without an explicit vmid_range every change is refused with the exact message", () => {
    const expected =
      "Set vmid_range for pve-host in the inventory before planning VM changes";
    const changes: ProxmoxInput[] = [
      { kind: "qemu", action: "start", vmid: 9003 },
      { kind: "qemu", action: "stop", vmid: 9003 },
      { kind: "lxc", action: "reboot", vmid: 9004 },
      { kind: "qemu", action: "shutdown", vmid: 9003 },
      {
        kind: "qemu",
        action: "clone",
        vmid: 9005,
        template: 9001,
        name: "sample-clone",
      },
      {
        kind: "lxc",
        action: "create",
        vmid: 9006,
        name: "sample-ct",
        template: "debian-12-standard_12.2-1_amd64.tar.zst",
        storage: "local-test",
        memory_mb: 512,
        cores: 1,
        disk_gb: 4,
        bridge: "vmbr0",
        address: "dhcp",
      },
      { kind: "qemu", action: "destroy", vmid: 9007, name: "sample-old" },
    ];
    for (const change of changes) {
      expect(messageOf(() => buildProxmoxPlan(change, unset))).toBe(expected);
    }
  });

  test("inspection still works on the default range without vmid_range", () => {
    expect(
      buildProxmoxPlan({ kind: "qemu", action: "list" }, unset).argv,
    ).toEqual(["qm", "list"]);
    expect(
      buildProxmoxPlan({ kind: "qemu", action: "status", vmid: 9003 }, unset)
        .argv,
    ).toEqual(["qm", "status", "9003"]);
  });

  test("destroy needs the guest name and refuses a protected VMID", () => {
    expect(
      messageOf(() =>
        buildProxmoxPlan(
          { kind: "qemu", action: "destroy", vmid: 9007 },
          facts,
        ),
      ),
    ).toBe(
      "Destroy needs the guest name: lowercase letters, digits and dashes",
    );
    expect(
      messageOf(() =>
        buildProxmoxPlan(
          { kind: "qemu", action: "destroy", vmid: 9009, name: "sample-old" },
          facts,
        ),
      ),
    ).toBe(
      "VM 9009 is listed in protected_vmids for pve-host and cannot be destroyed",
    );
  });

  test("provider facts report whether the range was set and carry protected VMIDs", () => {
    const bare = providerFacts({
      type: "proxmox",
      host: "pve-host",
      node: "pve-test",
    });
    expect(bare.vmidRangeSet).toBe(false);
    expect(bare.protectedVmids).toEqual([]);
    const set = providerFacts({
      type: "proxmox",
      host: "pve-host",
      node: "pve-test",
      vmid_range: [9001, 9010],
      protected_vmids: [9009],
    });
    expect(set.vmidRangeSet).toBe(true);
    expect(set.protectedVmids).toEqual([9009]);
    expect(set.host).toBe("pve-host");
  });
});
