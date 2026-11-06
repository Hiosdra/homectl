import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { controlCommand } from "../src/control/cli";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import { ControlPlane, controlStateDirectory } from "../src/control/engine";
import { ControlReplicator } from "../src/control/replicator";
import type { ClientIdentity } from "../src/control/types";
import {
  HomectlError,
  type ProcessResult,
  type ProcessSpec,
} from "../src/types";

// Synthetic local host; the runner is a fake. The approver is registered on
// another device, which this device sees only through its replicated state.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const INVENTORY = `version: 1
machines:
  lab-printer:
    description: Synthetic test host
    transport: local
    access: user
`;
const CHANGE = ["systemctl", "restart", "nginx"];

async function fixture(hook?: (id: string, host: string) => boolean) {
  const root = await mkdtemp(join(tmpdir(), "homectl-remote-approver-"));
  dirs.push(root);
  const inventoryPath = join(root, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const configPath = `${inventoryPath}.ssh_config`;
  const stateDirectory = controlStateDirectory(inventoryPath);
  const ran: ProcessSpec[] = [];
  const runner = async (spec: ProcessSpec): Promise<ProcessResult> => {
    ran.push(spec);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const options = {
    inventoryPath,
    configPath,
    stateDirectory,
    runner,
    approverAuthorized: hook,
  };
  const plane = new ControlPlane(options);
  await plane.init();
  const codexToken = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "inspect:read"],
    hosts: ["lab-printer"],
  });
  const hermesToken = await plane.createClient({
    id: "hermes-admin",
    name: "Hermes Admin",
    scopes: ["approve:decide", "status:read"],
    hosts: ["lab-printer"],
  });
  const codex = (await plane.authenticate(
    codexToken.token as string,
  )) as ClientIdentity;
  const hermes = (await plane.authenticate(
    hermesToken.token as string,
  )) as ClientIdentity;
  const planned = (await plane.request(
    { kind: "client", client: codex },
    { op: "plan", host: "lab-printer", argv: CHANGE },
  )) as { operationId: string; fingerprint: string };
  await plane.request(
    { kind: "client", client: hermes },
    {
      op: "approve",
      operationId: planned.operationId,
      fingerprint: planned.fingerprint,
      decision: "approve",
    },
  );
  // Registered on another device: this device's local registry does not hold it.
  const clientsPath = join(stateDirectory, "clients.json");
  const file = JSON.parse(await readFile(clientsPath, "utf8"));
  delete file.clients["hermes-admin"];
  await writeFile(clientsPath, JSON.stringify(file));
  return { options, operationId: planned.operationId, ran };
}

async function stateOf(
  options: ConstructorParameters<typeof ControlPlane>[0],
  operationId: string,
): Promise<{ state: string; reason?: string } | undefined> {
  const plane = new ControlPlane(options);
  await plane.init();
  return (await plane.listOperations({ all: true })).find(
    (o) => o.operationId === operationId,
  ) as { state: string; reason?: string } | undefined;
}

describe("remote-registered approvers at execution", () => {
  test("without replicated authority the operation is refused, not closed", async () => {
    const f = await fixture();
    const plane = new ControlPlane(f.options);
    await plane.init();
    let error: unknown;
    try {
      await plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: f.operationId },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HomectlError);
    expect((error as HomectlError).code).toBe(5);
    expect(f.ran.length).toBe(0);
    // Still approved: the refusal changed nothing, so a later run can succeed.
    const after = await stateOf(f.options, f.operationId);
    expect(after?.state).toBe("approved");
    expect(after?.reason).toBeUndefined();
  });

  test("with replicated authority that still grants approval, the operation runs", async () => {
    const f = await fixture(() => true);
    const plane = new ControlPlane(f.options);
    await plane.init();
    const ran = (await plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: f.operationId },
    )) as { operation: { state: string } };
    expect(ran.operation.state).toBe("succeeded");
    expect(f.ran.length).toBe(1);
  });

  test("replicated authority that no longer grants approval closes the operation", async () => {
    const f = await fixture(() => false);
    const plane = new ControlPlane(f.options);
    await plane.init();
    await expect(
      plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: f.operationId },
      ),
    ).rejects.toBeInstanceOf(HomectlError);
    const after = await stateOf(f.options, f.operationId);
    expect(after?.state).toBe("failed");
    expect(after?.reason).toBe("approval-invalidated");
  });
});

describe("control execute without a running serve", () => {
  test("uses the saved replica's authority for an approver registered on another device", async () => {
    const f = await fixture();
    const deviceDirectory = join(f.options.stateDirectory, "..", "device-key");
    const self = {
      id: "00000000-0000-4000-8000-0000000000bb",
      name: "this-device",
      key: await loadOrCreateDeviceKey(deviceDirectory),
    };
    // A saved replica that knows the approver's registration, as a sync leaves it.
    await ControlReplicator.open({
      plane: new ControlPlane(f.options),
      stateDirectory: f.options.stateDirectory,
      self,
    });
    const replicaPath = join(f.options.stateDirectory, "replica.json");
    const replica = JSON.parse(await readFile(replicaPath, "utf8"));
    replica.replica.clients["hermes-admin"] = {
      kind: "client",
      clientId: "hermes-admin",
      device: "00000000-0000-4000-8000-0000000000cc",
      name: "Hermes Admin",
      scopes: ["approve:decide", "status:read"],
      hosts: ["lab-printer"],
      createdAt: "2026-11-06T10:00:00.000Z",
      revoked: false,
    };
    await writeFile(replicaPath, JSON.stringify(replica));
    const result = await controlCommand({
      inventoryPath: f.options.inventoryPath,
      configPath: f.options.configPath,
      positionals: ["execute", f.operationId],
      runner: f.options.runner,
      values: {},
      dryRun: false,
      json: true,
    });
    expect(result.code).toBe(0);
    expect(
      (result.value as { operation: { state: string } }).operation.state,
    ).toBe("succeeded");
    expect(f.ran.length).toBe(1);
  });
});
