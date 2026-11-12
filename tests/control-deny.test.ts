import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import type { Actor } from "../src/control/types";
import { HomectlError } from "../src/types";

const INVENTORY = `version: 1
machines:
  lab-printer:
    description: Test printer host
    transport: local
    access: user
`;
const START = Date.UTC(2026, 10, 5, 10, 0, 0);
const CHANGE = ["systemctl", "restart", "nginx"];
const CODEX = {
  id: "codex-pc",
  scopes: ["status:read", "inspect:read", "plan:create"],
  hosts: ["lab-printer"],
};
const HERMES = {
  id: "hermes-admin",
  scopes: ["status:read", "inspect:read", "approve:decide"],
  hosts: ["lab-printer"],
};

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-deny-"));
  cleanup.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const clock = { now: START };
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory: join(dir, "control-plane"),
    runner: async () => ({ exitCode: 0, stdout: "Linux\n", stderr: "" }),
    clock: () => clock.now,
  });
  await plane.init();
  return { plane, clock };
}

async function client(
  plane: ControlPlane,
  input: { id: string; scopes: string[]; hosts: string[] },
) {
  const created = await plane.createClient({ name: input.id, ...input });
  const identity = await plane.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  return { kind: "client", client: identity } as Actor;
}

async function planChange(plane: ControlPlane, actor: Actor) {
  return (await plane.request(actor, {
    op: "plan",
    host: "lab-printer",
    argv: CHANGE,
  })) as {
    operationId: string;
    fingerprint: string;
  };
}

describe("local operator denies a request before it runs", () => {
  test("a pending change can be denied and is closed as failed, denied", async () => {
    const h = await harness();
    const codex = await client(h.plane, { ...CODEX });
    const plan = await planChange(h.plane, codex);
    const denied = await h.plane.denyOperation(plan.operationId);
    expect(denied.state).toBe("failed");
    expect(denied.reason).toBe("denied");
  });

  test("a denied request can no longer be approved", async () => {
    const h = await harness();
    const codex = await client(h.plane, { ...CODEX });
    const hermes = await client(h.plane, { ...HERMES });
    const plan = await planChange(h.plane, codex);
    await h.plane.denyOperation(plan.operationId);
    await expect(
      h.plane.request(hermes, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      }),
    ).rejects.toThrow("not awaiting approval");
  });

  test("a request that is already closed cannot be denied again", async () => {
    const h = await harness();
    const codex = await client(h.plane, { ...CODEX });
    const plan = await planChange(h.plane, codex);
    await h.plane.denyOperation(plan.operationId);
    await expect(
      h.plane.denyOperation(plan.operationId),
    ).rejects.toBeInstanceOf(HomectlError);
  });

  test("an unknown request is refused as unknown", async () => {
    const h = await harness();
    await expect(
      h.plane.denyOperation("00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow("Unknown operation");
  });
});
