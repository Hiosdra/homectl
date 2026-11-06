import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, controlStateDirectory } from "../src/control/engine";
import type { ClientIdentity } from "../src/control/types";
import {
  HomectlError,
  type ProcessResult,
  type ProcessSpec,
} from "../src/types";

// Synthetic Proxmox host (node pve-test, VMIDs 9001–9010). The runner is a fake:
// nothing contacts a real host. The inventory is edited between planning and
// execution, as an operator would.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function inventory(extra: { range?: string; protectedVmids?: string } = {}) {
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
    vmid_range: ${extra.range ?? "[9001, 9010]"}
${extra.protectedVmids ? `    protected_vmids: ${extra.protectedVmids}\n` : ""}    storages: [local-test]
`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "homectl-catalogue-recheck-"));
  dirs.push(root);
  const inventoryPath = join(root, "inventory.yaml");
  await writeFile(inventoryPath, inventory());
  const ran: ProcessSpec[] = [];
  const runner = async (spec: ProcessSpec): Promise<ProcessResult> => {
    ran.push(spec);
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  };
  const plane = new ControlPlane({
    inventoryPath,
    configPath: `${inventoryPath}.ssh_config`,
    stateDirectory: controlStateDirectory(inventoryPath),
    runner,
  });
  await plane.init();
  const codexToken = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "inspect:read"],
    hosts: ["pve-host"],
  });
  const hermesToken = await plane.createClient({
    id: "hermes-admin",
    name: "Hermes Admin",
    scopes: ["approve:decide", "status:read"],
    hosts: ["pve-host"],
  });
  const codex = (await plane.authenticate(
    codexToken.token as string,
  )) as ClientIdentity;
  const hermes = (await plane.authenticate(
    hermesToken.token as string,
  )) as ClientIdentity;
  return { inventoryPath, plane, codex, hermes, ran };
}

async function planAndApprove(
  f: Awaited<ReturnType<typeof fixture>>,
  fields: Record<string, unknown>,
): Promise<string> {
  const planned = (await f.plane.request(
    { kind: "client", client: f.codex },
    { op: "proxmox-plan", host: "pve-host", ...fields },
  )) as { operationId: string; fingerprint: string };
  await f.plane.request(
    { kind: "client", client: f.hermes },
    {
      op: "approve",
      operationId: planned.operationId,
      fingerprint: planned.fingerprint,
      decision: "approve",
    },
  );
  return planned.operationId;
}

async function executeRefusal(
  f: Awaited<ReturnType<typeof fixture>>,
  operationId: string,
): Promise<number | undefined> {
  try {
    await f.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId },
    );
  } catch (error) {
    return error instanceof HomectlError ? error.code : undefined;
  }
  return undefined;
}

describe("catalogue plans re-check the current inventory before running", () => {
  test("a queued destroy of a VM newly listed in protected_vmids is refused and never runs", async () => {
    const f = await fixture();
    const operationId = await planAndApprove(f, {
      kind: "qemu",
      action: "destroy",
      vmid: 9007,
      name: "sample-old",
    });
    await writeFile(f.inventoryPath, inventory({ protectedVmids: "[9007]" }));
    expect(await executeRefusal(f, operationId)).toBe(3);
    expect(f.ran.length).toBe(0);
    const view = (await f.plane.listOperations({ all: true })).find(
      (o) => o.operationId === operationId,
    );
    expect(view?.state).toBe("failed");
  });

  test("a queued start whose VMID leaves the narrowed vmid_range is refused and never runs", async () => {
    const f = await fixture();
    const operationId = await planAndApprove(f, {
      kind: "qemu",
      action: "start",
      vmid: 9003,
    });
    await writeFile(f.inventoryPath, inventory({ range: "[9001, 9002]" }));
    expect(await executeRefusal(f, operationId)).toBe(3);
    expect(f.ran.length).toBe(0);
  });

  test("with an unchanged inventory the same queued operation still runs", async () => {
    const f = await fixture();
    const operationId = await planAndApprove(f, {
      kind: "qemu",
      action: "start",
      vmid: 9003,
    });
    const result = (await f.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId },
    )) as { operation: { state: string } };
    expect(result.operation.state).toBe("succeeded");
    expect(f.ran.length).toBe(1);
  });
});
