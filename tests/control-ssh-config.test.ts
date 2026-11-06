import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, controlStateDirectory } from "../src/control/engine";
import type { ClientIdentity } from "../src/control/types";
import type { ProcessResult, ProcessSpec } from "../src/types";

// Synthetic SSH host on the TEST-NET range. The runner is a fake: no SSH runs.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function inventory(address: string): string {
  return `version: 1
session:
  ttl: 1h
  database: /tmp/homectl-synthetic/vault.kdbx
machines:
  pve-host:
    description: Synthetic SSH host
    transport: ssh
    access: user
    ssh_alias: pve-host
    address: ${address}
    user: ops
    auth:
      type: keepassxc
      entry: homectl-pve-host
      socket: /tmp/homectl-synthetic/agent.sock
      public_key: /tmp/homectl-synthetic/pve-host.pub
`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "homectl-ssh-config-"));
  dirs.push(root);
  const inventoryPath = join(root, "inventory.yaml");
  const configPath = `${inventoryPath}.ssh_config`;
  await writeFile(inventoryPath, inventory("192.0.2.10"));
  // The managed config on disk is stale: it still names the old address.
  await writeFile(configPath, "Host pve-host\n  HostName 192.0.2.99\n");
  const seenConfigs: string[] = [];
  const runner = async (spec: ProcessSpec): Promise<ProcessResult> => {
    // What the transport would read when it connects.
    seenConfigs.push(await readFile(configPath, "utf8").catch(() => ""));
    return { exitCode: 0, stdout: "Linux\n", stderr: "" };
  };
  const plane = new ControlPlane({
    inventoryPath,
    configPath,
    stateDirectory: controlStateDirectory(inventoryPath),
    runner,
  });
  await plane.init();
  const token = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "inspect:read"],
    hosts: ["pve-host"],
  });
  const client = (await plane.authenticate(
    token.token as string,
  )) as ClientIdentity;
  return { inventoryPath, plane, client, seenConfigs };
}

describe("managed SSH config before a control execution", () => {
  test("an address edited in the inventory is the one the command is sent to", async () => {
    const f = await fixture();
    // The operator edits the address; the next plan is made from the new inventory.
    await writeFile(f.inventoryPath, inventory("192.0.2.11"));
    const planned = (await f.plane.request(
      { kind: "client", client: f.client },
      { op: "plan", host: "pve-host", argv: ["uname", "-s"] },
    )) as { operationId: string };
    await f.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: planned.operationId },
    );
    const used = f.seenConfigs.at(-1) ?? "";
    expect(used).toContain("192.0.2.11");
    expect(used).not.toContain("192.0.2.99");
  });
});
