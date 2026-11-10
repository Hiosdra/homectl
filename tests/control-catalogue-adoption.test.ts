import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, controlStateDirectory } from "../src/control/engine";
import type { ClientIdentity } from "../src/control/types";
import { HomectlError, type ProcessResult } from "../src/types";

// Two synthetic devices with inventories that describe the same Proxmox host
// (node pve-test, VMIDs 9001–9010). The runner is a fake; nothing is contacted.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function inventory(user = "ops", range = "[9001, 9010]") {
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
    user: ${user}
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
    vmid_range: ${range}
    storages: [local-test]
`;
}

async function device(text: string) {
  const root = await mkdtemp(join(tmpdir(), "homectl-catalogue-adoption-"));
  dirs.push(root);
  const inventoryPath = join(root, "inventory.yaml");
  await writeFile(inventoryPath, text);
  const plane = new ControlPlane({
    inventoryPath,
    configPath: `${inventoryPath}.ssh_config`,
    stateDirectory: controlStateDirectory(inventoryPath),
    runner: async (): Promise<ProcessResult> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
  });
  await plane.init();
  return plane;
}

describe("catalogue plans handed to another device", () => {
  test("the receiving device rebuilds the typed plan from its own facts and holds the same fingerprint", async () => {
    const a = await device(inventory());
    const token = await a.createClient({
      id: "codex-pc",
      name: "Codex PC",
      scopes: ["plan:create", "inspect:read"],
      hosts: ["pve-host"],
    });
    const codex = (await a.authenticate(
      token.token as string,
    )) as ClientIdentity;
    const planned = (await a.request(
      { kind: "client", client: codex },
      {
        op: "proxmox-plan",
        host: "pve-host",
        kind: "qemu",
        action: "start",
        vmid: 9003,
        name: "sample-vm",
      },
    )) as { operationId: string; fingerprint: string };
    const view = (await a.listOperations({ all: true })).find(
      (o) => o.operationId === planned.operationId,
    );
    // The replicated view carries the typed input, so a takeover can rebuild it.
    expect(view?.catalogueInput).toEqual({
      kind: "qemu",
      action: "start",
      vmid: 9003,
      name: "sample-vm",
    });

    const b = await device(inventory());
    await b.adoptOperation({
      operationId: planned.operationId,
      host: "pve-host",
      argv: view?.argv ?? [],
      impact: view?.impact ?? "",
      issuer: "codex-pc",
      catalogueInput: view?.catalogueInput,
      fingerprint: planned.fingerprint,
    });
    const adopted = (await b.listOperations({ all: true })).find(
      (o) => o.operationId === planned.operationId,
    );
    expect(adopted?.state).toBe("pending");
    expect(adopted?.fingerprint).toBe(planned.fingerprint);
    expect(adopted?.argv).toEqual(["sudo", "-n", "qm", "start", "9003"]);
  });

  test("a receiving device whose facts refuse the operation does not adopt it", async () => {
    const a = await device(inventory());
    const token = await a.createClient({
      id: "codex-pc",
      name: "Codex PC",
      scopes: ["plan:create", "inspect:read"],
      hosts: ["pve-host"],
    });
    const codex = (await a.authenticate(
      token.token as string,
    )) as ClientIdentity;
    const planned = (await a.request(
      { kind: "client", client: codex },
      {
        op: "proxmox-plan",
        host: "pve-host",
        kind: "qemu",
        action: "start",
        vmid: 9003,
        name: "sample-vm",
      },
    )) as { operationId: string; fingerprint: string };
    const view = (await a.listOperations({ all: true })).find(
      (o) => o.operationId === planned.operationId,
    );
    // This device's range no longer contains the VMID.
    const b = await device(inventory("ops", "[9001, 9002]"));
    let code: number | undefined;
    let message = "";
    try {
      await b.adoptOperation({
        operationId: planned.operationId,
        host: "pve-host",
        argv: view?.argv ?? [],
        impact: view?.impact ?? "",
        issuer: "codex-pc",
        catalogueInput: view?.catalogueInput,
        fingerprint: planned.fingerprint,
      });
    } catch (error) {
      code = error instanceof HomectlError ? error.code : undefined;
      message = error instanceof Error ? error.message : "";
    }
    expect(code).toBe(3);
    expect(message).toContain("takeover refused");
    expect(
      (await b.listOperations({ all: true })).some(
        (o) => o.operationId === planned.operationId,
      ),
    ).toBe(false);
  });

  test("a device that describes the machine differently refuses rather than adopting another plan", async () => {
    const a = await device(inventory("ops"));
    const token = await a.createClient({
      id: "codex-pc",
      name: "Codex PC",
      scopes: ["plan:create", "inspect:read"],
      hosts: ["pve-host"],
    });
    const codex = (await a.authenticate(
      token.token as string,
    )) as ClientIdentity;
    const planned = (await a.request(
      { kind: "client", client: codex },
      {
        op: "proxmox-plan",
        host: "pve-host",
        kind: "qemu",
        action: "start",
        vmid: 9003,
      },
    )) as { operationId: string; fingerprint: string };
    const view = (await a.listOperations({ all: true })).find(
      (o) => o.operationId === planned.operationId,
    );
    // Same range, but the receiving device runs guest commands as root (no sudo prefix).
    const b = await device(inventory("root"));
    let code: number | undefined;
    let message = "";
    try {
      await b.adoptOperation({
        operationId: planned.operationId,
        host: "pve-host",
        argv: view?.argv ?? [],
        impact: view?.impact ?? "",
        issuer: "codex-pc",
        catalogueInput: view?.catalogueInput,
        fingerprint: planned.fingerprint,
      });
    } catch (error) {
      code = error instanceof HomectlError ? error.code : undefined;
      message = error instanceof Error ? error.message : "";
    }
    expect(code).toBe(3);
    expect(message).toContain("takeover refused");
  });
});
