import { describe, expect, test } from "bun:test";
import type { ProxmoxFacts } from "../src/proxmox/catalogue";
import { fullApiRequest, fullOperation } from "../src/proxmox/full";
import { HomectlError } from "../src/types";

// Synthetic facts only: node pve-test, VMIDs 9001 to 9010, one protected VMID.
const facts: ProxmoxFacts = {
  host: "pve-host",
  node: "pve-test",
  vmidMin: 9001,
  vmidMax: 9010,
  vmidRangeSet: true,
  protectedVmids: [9009],
  storages: ["local-test"],
  templates: [],
};

type Req = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  params?: Record<string, string>;
};

function run(req: Req, f: ProxmoxFacts = facts) {
  return fullOperation(req, f);
}

// Returns the error code and message a request is refused with, or undefined.
function refusal(req: Req, f: ProxmoxFacts = facts) {
  try {
    run(req, f);
  } catch (error) {
    if (error instanceof HomectlError)
      return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}

describe("allowed requests", () => {
  test("reads are inspection with no approval class", () => {
    const op = run({ method: "GET", path: "/nodes/pve-test/qemu/9003/config" });
    expect(op.classification).toBe("inspect");
    expect(op.risk).toBe("R1");
    expect(op.ownerOnly).toBe(false);
    expect(op.label).toBe("Configuration of VM 9003");
    expect(op.vmid).toBe(9003);
  });

  test("guest changes are routine mutations with plain labels", () => {
    const start = run({
      method: "POST",
      path: "/nodes/pve-test/qemu/9003/status/start",
    });
    expect(start.classification).toBe("mutation");
    expect(start.label).toBe("Start VM 9003");
    const lxc = run({
      method: "POST",
      path: "/nodes/pve-test/lxc/9004/status/stop",
    });
    expect(lxc.label).toBe("Force stop container 9004");
    const config = run({
      method: "PUT",
      path: "/nodes/pve-test/qemu/9003/config",
      params: { memory: "2048" },
    });
    expect(config.classification).toBe("mutation");
    expect(config.params).toEqual({ memory: "2048" });
  });

  test("snapshot rollback and snapshot delete are destructive (R4) but not owner-only", () => {
    const rollback = run({
      method: "POST",
      path: "/nodes/pve-test/qemu/9003/snapshot/before-upgrade/rollback",
    });
    expect(rollback.classification).toBe("destructive");
    expect(rollback.risk).toBe("R4");
    expect(rollback.ownerOnly).toBe(false);
    const del = run({
      method: "DELETE",
      path: "/nodes/pve-test/qemu/9003/snapshot/before-upgrade",
    });
    expect(del.classification).toBe("destructive");
    expect(del.ownerOnly).toBe(false);
  });

  test("creating and cloning name an id inside the range", () => {
    const create = run({
      method: "POST",
      path: "/nodes/pve-test/lxc",
      params: { vmid: "9004", hostname: "sample-ct" },
    });
    expect(create.risk).toBe("R3");
    const clone = run({
      method: "POST",
      path: "/nodes/pve-test/qemu/9003/clone",
      params: { newid: "9005", name: "sample-copy" },
    });
    expect(clone.classification).toBe("mutation");
  });

  test("storage content deletion is owner-only, with the volume id slash encoded", () => {
    const op = run({
      method: "DELETE",
      path: "/nodes/pve-test/storage/local-test/content/local-test:backup%2Fvzdump-qemu-9003.vma.zst",
    });
    expect(op.ownerOnly).toBe(true);
    expect(op.classification).toBe("destructive");
  });

  test("node, cluster and storage reads need no approval", () => {
    for (const path of [
      "/version",
      "/nodes",
      "/nodes/pve-test/status",
      "/nodes/pve-test/firewall/rules",
      "/cluster/resources",
      "/cluster/backup",
      "/storage",
    ])
      expect(run({ method: "GET", path }).classification).toBe("inspect");
  });

  test("the request builder keeps the approved method, path and parameters", () => {
    const op = run({
      method: "PUT",
      path: "/nodes/pve-test/qemu/9003/config",
      params: { memory: "2048" },
    });
    expect(fullApiRequest(op)).toEqual({
      method: "PUT",
      path: "/nodes/pve-test/qemu/9003/config",
      params: { memory: "2048" },
      task: true,
      inspect: false,
      redact: true,
    });
    expect(
      fullApiRequest(run({ method: "GET", path: "/version" })).inspect,
    ).toBe(true);
  });
});

describe("path validation", () => {
  test("paths that could escape the route or inject a command are refused", () => {
    for (const path of [
      "/nodes/pve-test/../../access/users",
      "/nodes/pve-test/qemu/9003/config?x=1",
      "/nodes/pve-test/qemu/9003/config#frag",
      "/nodes/pve-test/qemu/9003/config%2e%2e",
      "/nodes/pve-test/qemu/9003/config/",
      "/nodes/pve-test/qemu/9003/config;rm",
      "/nodes/pve-test/qemu/9003/config x",
      "nodes/pve-test/qemu/9003/config",
      "/nodes//qemu",
      "/nodes/pve-test\\qemu",
      "/",
    ])
      expect(refusal({ method: "GET", path })?.code).toBe(2);
  });

  test("a different node in the path is refused", () => {
    expect(
      refusal({ method: "GET", path: "/nodes/other-node/qemu" })?.message,
    ).toBe("Only the provider's node can be named in a path");
  });

  test("paths outside the route table are refused, shell-like endpoints included", () => {
    for (const req of [
      { method: "POST" as const, path: "/nodes/pve-test/qemu/9003/termproxy" },
      { method: "GET" as const, path: "/nodes/pve-test/qemu/9003/unknown" },
      {
        method: "POST" as const,
        path: "/nodes/pve-test/qemu/9003/status/bogus",
      },
    ])
      expect(refusal(req)?.code).toBe(3);
  });

  test("access control paths are planned but owner-only, never plain", () => {
    const ticket = run({ method: "POST", path: "/access/ticket" });
    expect(ticket.ownerOnly).toBe(true);
    expect(ticket.classification).toBe("destructive");
  });

  test("an unknown method is refused", () => {
    expect(
      refusal({ method: "PATCH" as unknown as "GET", path: "/version" })?.code,
    ).toBe(2);
  });
});

describe("guest scope", () => {
  test("ids outside vmid_range are refused", () => {
    expect(
      refusal({ method: "GET", path: "/nodes/pve-test/qemu/9011/config" })
        ?.message,
    ).toContain("outside the provider's vmid_range");
    expect(
      refusal({
        method: "POST",
        path: "/nodes/pve-test/qemu/9011/status/start",
      })?.code,
    ).toBe(3);
  });

  test("changes need an explicit vmid_range, reads do not", () => {
    const noRange = { ...facts, vmidRangeSet: false };
    expect(
      refusal(
        { method: "POST", path: "/nodes/pve-test/qemu/9003/status/start" },
        noRange,
      )?.message,
    ).toContain("Set vmid_range");
    expect(
      refusal(
        { method: "GET", path: "/nodes/pve-test/qemu/9003/config" },
        noRange,
      ),
    ).toBeUndefined();
  });

  test("protected VMIDs cannot be destroyed or rolled back, snapshots included", () => {
    expect(
      refusal({
        method: "DELETE",
        path: "/nodes/pve-test/qemu/9009/snapshot/before-upgrade",
      })?.message,
    ).toContain("protected_vmids");
    expect(
      refusal({ method: "DELETE", path: "/nodes/pve-test/qemu/9009" })?.message,
    ).toContain("protected_vmids");
    expect(
      refusal({
        method: "POST",
        path: "/nodes/pve-test/qemu/9009/snapshot/s1/rollback",
      })?.message,
    ).toContain("protected_vmids");
    expect(
      refusal({
        method: "POST",
        path: "/nodes/pve-test/qemu/9003/clone",
        params: { newid: "9009" },
      })?.message,
    ).toContain("protected_vmids");
  });

  test("create and clone must name their id; a missing id would let Proxmox choose one", () => {
    expect(
      refusal({
        method: "POST",
        path: "/nodes/pve-test/qemu",
        params: { name: "x" },
      })?.message,
    ).toContain("explicit vmid");
    expect(
      refusal({ method: "POST", path: "/nodes/pve-test/qemu/9003/clone" })
        ?.message,
    ).toContain("explicit newid");
  });

  test("ids in parameters are range checked too", () => {
    expect(
      refusal({
        method: "POST",
        path: "/nodes/pve-test/qemu",
        params: { vmid: "9999" },
      })?.message,
    ).toContain("outside the provider's vmid_range");
  });
});

describe("parameters", () => {
  test("secret-looking parameters are refused and never echoed", () => {
    const refused = refusal({
      method: "PUT",
      path: "/nodes/pve-test/qemu/9003/config",
      params: { cipassword: "hunter2" },
    });
    expect(refused?.code).toBe(3);
    expect(refused?.message).toContain("looks like a secret");
    expect(refused?.message).not.toContain("hunter2");
    expect(
      refusal({
        method: "PUT",
        path: "/nodes/pve-test/qemu/9003/config",
        params: { description: "password=hunter2" },
      })?.code,
    ).toBe(3);
  });

  test("parameters that bypass safety checks are refused", () => {
    expect(
      refusal({
        method: "POST",
        path: "/nodes/pve-test/qemu",
        params: { vmid: "9004", force: "1" },
      })?.message,
    ).toContain("bypasses");
  });

  test("malformed parameter names, values and counts are refused", () => {
    expect(
      refusal({
        method: "PUT",
        path: "/nodes/pve-test/qemu/9003/config",
        params: { "bad name": "1" },
      })?.code,
    ).toBe(2);
    expect(
      refusal({
        method: "PUT",
        path: "/nodes/pve-test/qemu/9003/config",
        params: { memory: "a\nb" },
      })?.code,
    ).toBe(2);
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i++) many[`p${i}`] = "1";
    expect(
      refusal({
        method: "PUT",
        path: "/nodes/pve-test/qemu/9003/config",
        params: many,
      })?.code,
    ).toBe(2);
  });
});

describe("storage allowlist", () => {
  test("storages named in a path or parameter must be listed by the provider", () => {
    expect(
      refusal({
        method: "GET",
        path: "/nodes/pve-test/storage/other-store/content",
      })?.message,
    ).toContain("Storage is not allowed");
    expect(
      refusal({
        method: "POST",
        path: "/nodes/pve-test/vzdump",
        params: { storage: "other-store" },
      })?.message,
    ).toContain("Storage is not allowed");
  });

  test("with no storages listed, storage operations are refused", () => {
    expect(
      refusal(
        { method: "GET", path: "/nodes/pve-test/storage/local-test/content" },
        { ...facts, storages: [] },
      )?.message,
    ).toContain("Set storages");
  });
});
