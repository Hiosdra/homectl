import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane, controlStateDirectory } from "../src/control/engine";
import type { ClientIdentity } from "../src/control/types";

// Synthetic local device. The "executing" record is written by hand to imitate
// an interrupted executor; nothing runs.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "homectl-executor-"));
  dirs.push(root);
  const inventoryPath = join(root, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const options = {
    inventoryPath,
    configPath: `${inventoryPath}.ssh_config`,
    stateDirectory: controlStateDirectory(inventoryPath),
  };
  const plane = new ControlPlane(options);
  await plane.init();
  const token = await plane.createClient({
    id: "codex-pc",
    name: "Codex PC",
    scopes: ["plan:create", "inspect:read"],
    hosts: ["agent-host"],
  });
  const client = (await plane.authenticate(
    token.token as string,
  )) as ClientIdentity;
  const planned = (await plane.request(
    { kind: "client", client },
    { op: "plan", host: "agent-host", argv: ["uname", "-s"] },
  )) as { operationId: string };
  return { options, plane, operationId: planned.operationId };
}

// Marks the operation as executing by a given executor, as an interrupted run would leave it.
async function leaveExecuting(
  statePath: string,
  operationId: string,
  executor: { pid: number; instance?: string },
) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const op = state.operations[operationId];
  op.state = "executing";
  op.executorPid = executor.pid;
  if (executor.instance !== undefined) op.executorInstance = executor.instance;
  op.startedAt = Date.now();
  await writeFile(statePath, JSON.stringify(state));
}

async function stateOf(
  plane: ControlPlane,
  operationId: string,
): Promise<string | undefined> {
  return (await plane.listOperations({ all: true })).find(
    (o) => o.operationId === operationId,
  )?.state;
}

describe("interrupted executor detection", () => {
  test("an executor pid that matches this process but a different instance is not alive: the operation is recovered as unknown", async () => {
    const f = await fixture();
    const statePath = join(f.options.stateDirectory, "state.json");
    // This process's pid, but written by an earlier incarnation (e.g. pid 1 in
    // a restarted container): the pid is reused, the instance is not.
    await leaveExecuting(statePath, f.operationId, {
      pid: process.pid,
      instance: "00000000-0000-4000-8000-00000000dead",
    });
    const restarted = new ControlPlane(f.options);
    await restarted.init();
    expect(await stateOf(restarted, f.operationId)).toBe("unknown");
  });

  test("a legacy record with no executor instance and this process's pid is not alive either", async () => {
    const f = await fixture();
    const statePath = join(f.options.stateDirectory, "state.json");
    await leaveExecuting(statePath, f.operationId, { pid: process.pid });
    const restarted = new ControlPlane(f.options);
    await restarted.init();
    expect(await stateOf(restarted, f.operationId)).toBe("unknown");
  });
});
