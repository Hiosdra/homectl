import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import type { Actor } from "../src/control/types";
import type { ProcessSpec, Runner } from "../src/types";

// Round-8 regression: 0.2.1-accepted secret-looking names (KEY=value, key=app,
// "Rotate SSH key") must still be planned and executed; only redaction changed.
const INVENTORY = `version: 1
machines:
  lab-printer:
    description: Test printer host
    transport: local
    access: user
`;
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
const START = Date.UTC(2026, 10, 5, 10, 0, 0);
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-control-secret-argv-"));
  cleanup.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const calls: ProcessSpec[] = [];
  const runner: Runner = async (spec) => {
    calls.push(spec);
    return { exitCode: 0, stdout: "Linux\n", stderr: "" };
  };
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory: join(dir, "control-plane"),
    runner,
    clock: () => START,
  });
  await plane.init();
  return { plane, calls, dir };
}

async function actorFor(
  plane: ControlPlane,
  input: { id: string; scopes: string[]; hosts: string[] },
): Promise<Actor> {
  const created = await plane.createClient({ name: input.id, ...input });
  const identity = await plane.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  return { kind: "client", client: identity } as Actor;
}

async function planOn(
  plane: ControlPlane,
  actor: Actor,
  argv: string[],
  extra: Record<string, unknown> = {},
) {
  return (await plane.request(actor, {
    op: "plan",
    host: "lab-printer",
    argv,
    ...extra,
  })) as { operationId: string; fingerprint: string; state: string };
}

test("0.2.1-accepted KEY= argv and key/auth impact text are planned, not refused", async () => {
  const h = await harness();
  const codex = await actorFor(h.plane, CODEX);
  const env = await planOn(h.plane, codex, ["uname", "KEY=value"]);
  expect(env.state).toBe("pending");
  const selector = await planOn(h.plane, codex, ["uname", "-l", "key=app"]);
  expect(selector.state).toBe("pending");
  const rotation = await planOn(h.plane, codex, ["uname"], {
    impact: "Rotate SSH key: host1",
  });
  expect(rotation.state).toBe("pending");
});

test("an approved operation with KEY=value argv still executes and journals", async () => {
  const h = await harness();
  const codex = await actorFor(h.plane, CODEX);
  const hermes = await actorFor(h.plane, HERMES);
  const argv = ["rm", "-f", "/tmp/homectl-slice1-fixture", "KEY=value"];
  const plan = await planOn(h.plane, codex, argv);
  await h.plane.request(hermes, {
    op: "approve",
    operationId: plan.operationId,
    fingerprint: plan.fingerprint,
    decision: "approve",
  });
  const result = (await h.plane.request(
    { kind: "local-operator" },
    { op: "execute", operationId: plan.operationId },
  )) as { operation: { state: string } };
  expect(result.operation.state).toBe("succeeded");
  expect(h.calls).toHaveLength(1);
  const audit = await readFile(
    join(h.dir, "control-plane", "audit.jsonl"),
    "utf8",
  );
  expect(audit).toContain('"operation.succeeded"');
  expect(audit).not.toContain("KEY=value");
});
