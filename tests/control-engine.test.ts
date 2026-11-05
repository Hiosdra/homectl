import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_TTL_MS,
  ControlPlane,
  PLAN_TTL_MS,
} from "../src/control/engine";
import { schemas } from "../src/control/schema";
import type { Actor, ClientIdentity } from "../src/control/types";
import { HomectlError, type ProcessSpec, type Runner } from "../src/types";

const INVENTORY = `version: 1
machines:
  lab-printer:
    description: Test printer host
    transport: local
    access: user
  nas:
    description: Test NAS host
    transport: local
    access: sudo-approved
    sudo_allow:
      - ["/usr/bin/systemctl", "status", "nginx"]
  big:
    description: Test full-access host
    transport: local
    access: full
`;
const START = Date.UTC(2026, 10, 5, 10, 0, 0);
// A mutation: needs a second client to approve. Runs only through the fake runner.
const CHANGE = ["systemctl", "restart", "nginx"];
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

type Harness = {
  plane: ControlPlane;
  calls: ProcessSpec[];
  clock: { now: number };
  dir: string;
  inventoryPath: string;
};

// Every process the engine would spawn is recorded here; none is started.
async function harness(runner?: Runner): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-control-"));
  cleanup.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const calls: ProcessSpec[] = [];
  const clock = { now: START };
  const base: Runner =
    runner ?? (async () => ({ exitCode: 0, stdout: "Linux\n", stderr: "" }));
  const recording: Runner = (spec) => {
    calls.push(spec);
    return base(spec);
  };
  const plane = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory: join(dir, "control-plane"),
    runner: recording,
    clock: () => clock.now,
  });
  await plane.init();
  return { plane, calls, clock, dir, inventoryPath };
}

async function client(
  h: Harness,
  input: { id: string; scopes: string[]; hosts: string[] },
) {
  const created = await h.plane.createClient({
    name: input.id,
    ...input,
  });
  const identity = await h.plane.authenticate(created.token);
  if (!identity) throw new Error("token did not authenticate");
  return {
    token: created.token,
    actor: { kind: "client", client: identity } as Actor,
    identity,
  };
}

const CODEX = {
  id: "codex-pc",
  scopes: ["status:read", "inspect:read", "plan:create"],
  hosts: ["lab-printer", "nas"],
};
const HERMES = {
  id: "hermes-admin",
  scopes: ["status:read", "inspect:read", "approve:decide"],
  hosts: ["lab-printer", "nas"],
};

async function expectCode(
  promise: Promise<unknown>,
  code: number,
  text?: string,
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HomectlError);
  expect((caught as HomectlError).code).toBe(code);
  if (text) expect((caught as HomectlError).message).toContain(text);
}

// Round-trip through JSON to drop undefined members, then validate.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function planOn(
  h: Harness,
  actor: Actor,
  host: string,
  argv: string[],
  extra: Record<string, unknown> = {},
) {
  return (await h.plane.request(actor, {
    op: "plan",
    host,
    argv,
    ...extra,
  })) as { operationId: string; fingerprint: string; state: string };
}

describe("client identities and tokens", () => {
  test("each token authenticates only its own identity", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    expect(codex.identity.id).toBe("codex-pc");
    expect(hermes.identity.id).toBe("hermes-admin");
    expect(codex.identity.scopes).not.toContain("approve:decide");
    expect(hermes.identity.scopes).not.toContain("plan:create");
    expect(await h.plane.authenticate(`hct_${"A".repeat(43)}`)).toBeNull();
    expect(await h.plane.authenticate("not-a-token")).toBeNull();
    expect(await h.plane.authenticate(undefined)).toBeNull();
  });

  test("only token digests are stored at rest", async () => {
    const h = await harness();
    const created = await h.plane.createClient({
      id: "codex-pc",
      name: "Codex PC",
      scopes: ["status:read"],
      hosts: ["lab-printer"],
    });
    const stored = await readFile(
      join(h.dir, "control-plane", "clients.json"),
      "utf8",
    );
    expect(stored).not.toContain(created.token);
    const record = JSON.parse(stored).clients["codex-pc"];
    expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(schemas.clientView(json(created.client))).toBe(true);
  });

  test("revocation takes effect on the next authentication", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    expect(await h.plane.authenticate(codex.token)).not.toBeNull();
    await h.plane.revokeClient("codex-pc");
    expect(await h.plane.authenticate(codex.token)).toBeNull();
    const listed = await h.plane.listClients();
    expect(listed.find((c) => c.id === "codex-pc")?.revoked).toBe(true);
  });

  test("client creation validates identity, scopes, grants and reserved ids", async () => {
    const h = await harness();
    const base = {
      name: "Test",
      scopes: ["status:read"],
      hosts: ["lab-printer"],
    };
    await expectCode(
      h.plane.createClient({ ...base, id: "local-operator" }),
      2,
      "reserved",
    );
    await expectCode(
      h.plane.createClient({ ...base, id: "control-plane" }),
      2,
      "reserved",
    );
    await expectCode(h.plane.createClient({ ...base, id: "Bad Id" }), 2);
    await expectCode(
      h.plane.createClient({ ...base, id: "x", scopes: ["exec:run"] }),
      2,
    );
    await expectCode(h.plane.createClient({ ...base, id: "x", scopes: [] }), 2);
    await expectCode(h.plane.createClient({ ...base, id: "x", hosts: [] }), 2);
    await expectCode(
      h.plane.createClient({ ...base, id: "x", hosts: ["*"] }),
      2,
    );
    await h.plane.createClient({ ...base, id: "dup" });
    await expectCode(
      h.plane.createClient({ ...base, id: "dup" }),
      2,
      "already exists",
    );
  });

  test("a revoked client's stored grants are never reused by a new id", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    await h.plane.revokeClient("codex-pc");
    await expectCode(
      h.plane.createClient({ ...CODEX, name: "Again" }),
      2,
      "already exists",
    );
    expect(await h.plane.authenticate(codex.token)).toBeNull();
  });
});

test("host grants must name hosts that exist in the inventory", async () => {
  const h = await harness();
  await expectCode(
    h.plane.createClient({
      id: "typo-client",
      name: "Typo",
      scopes: ["plan:create"],
      hosts: ["lab-printr"],
    }),
    2,
    "Unknown inventory host(s): lab-printr. Valid hosts: big, lab-printer, nas",
  );
  expect((await h.plane.listClients()).map((c) => c.id)).not.toContain(
    "typo-client",
  );
});

describe("plan creation and screening", () => {
  test("a granted client creates a pending, fingerprinted plan", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    expect(plan.state).toBe("pending");
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const status = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    })) as unknown;
    expect(schemas.operationView(json(status))).toBe(true);
    const audit = await readFile(
      join(h.dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"operation.planned"');
  });

  test("ungranted and unknown hosts receive the same generic refusal", async () => {
    const h = await harness();
    const codex = await client(h, { ...CODEX, hosts: ["lab-printer"] });
    await expectCode(
      h.plane.request(codex.actor, {
        op: "plan",
        host: "nas",
        argv: ["uname"],
      }),
      3,
      "Host not permitted for this client",
    );
    await expectCode(
      h.plane.request(codex.actor, {
        op: "plan",
        host: "ghost",
        argv: ["uname"],
      }),
      3,
      "Host not permitted for this client",
    );
  });

  test("a client without plan:create cannot plan", async () => {
    const h = await harness();
    const hermes = await client(h, HERMES);
    await expectCode(
      h.plane.request(hermes.actor, {
        op: "plan",
        host: "lab-printer",
        argv: ["uname"],
      }),
      3,
      "Client lacks the scope",
    );
  });

  test("full-access hosts are never planned through the control plane", async () => {
    const h = await harness();
    const codex = await client(h, { ...CODEX, hosts: ["big"] });
    await expectCode(
      planOn(h, codex.actor, "big", CHANGE),
      3,
      "Full-access hosts",
    );
  });

  test("shells, interpreters and wrapped shells are refused", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    await expectCode(
      planOn(h, codex.actor, "lab-printer", ["sh", "-c", "id"]),
      3,
      "Shell",
    );
    await expectCode(
      planOn(h, codex.actor, "lab-printer", ["python3", "-c", "print(1)"]),
      3,
    );
    await expectCode(planOn(h, codex.actor, "lab-printer", ["env", "sh"]), 3);
    await expectCode(planOn(h, codex.actor, "nas", ["sudo", "-n", "sh"]), 3);
  });

  test("docker socket access and container mutation are refused; inspection is allowed", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    await expectCode(
      planOn(h, codex.actor, "lab-printer", [
        "tool",
        "--unix-socket",
        "/var/run/docker.sock",
      ]),
      3,
      "Container runtime sockets",
    );
    await expectCode(
      planOn(h, codex.actor, "lab-printer", ["docker", "rm", "web"]),
      3,
      "Container",
    );
    const ok = await planOn(h, codex.actor, "lab-printer", ["docker", "ps"]);
    expect(ok.state).toBe("pending");
  });

  test("argv that is not exactly allowlisted for sudo-approved hosts is refused by policy", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    await expectCode(
      planOn(h, codex.actor, "nas", [
        "sudo",
        "-n",
        "/usr/bin/systemctl",
        "restart",
        "nginx",
      ]),
      3,
      "not exactly allowlisted",
    );
    const ok = await planOn(h, codex.actor, "nas", [
      "sudo",
      "-n",
      "/usr/bin/systemctl",
      "status",
      "nginx",
    ]);
    expect(ok.state).toBe("pending");
  });

  test("secret-like material is refused and never reaches state or the journal", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    await expectCode(
      planOn(h, codex.actor, "lab-printer", [
        "tool",
        "--password=hunter2-secret",
      ]),
      2,
      "Secret-like",
    );
    await expectCode(
      planOn(h, codex.actor, "lab-printer", ["uname"], {
        impact: "token: hct_abcdefghijklmnop1234",
      }),
      2,
      "Secret-like",
    );
    // Refused before any write, so state.json may not exist at all.
    const state = await readFile(
      join(h.dir, "control-plane", "state.json"),
      "utf8",
    ).catch(() => "");
    const audit = await readFile(
      join(h.dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(state).not.toContain("hunter2");
    expect(state).not.toContain("hct_abcdefghijklmnop1234");
    expect(audit).not.toContain("hunter2");
    expect(audit).toContain('"request.rejected"');
  });

  test("malformed requests are refused with a fixed message and audited", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    await expectCode(
      h.plane.request(codex.actor, {
        op: "execute",
        operationId: "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
        argv: ["rm"],
      }),
      2,
      "Invalid control-plane request",
    );
    const audit = await readFile(
      join(h.dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"request.rejected"');
  });

  test("idempotency keys return the same operation and refuse reuse for a different request", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const first = await planOn(h, codex.actor, "lab-printer", CHANGE, {
      idempotencyKey: "job-1",
    });
    const again = await planOn(h, codex.actor, "lab-printer", CHANGE, {
      idempotencyKey: "job-1",
    });
    expect(again.operationId).toBe(first.operationId);
    const state = JSON.parse(
      await readFile(join(h.dir, "control-plane", "state.json"), "utf8"),
    );
    expect(Object.keys(state.operations)).toHaveLength(1);
    await expectCode(
      planOn(h, codex.actor, "lab-printer", ["uname", "-a"], {
        idempotencyKey: "job-1",
      }),
      3,
      "already used for a different request",
    );
  });

  test("plans expire; status reports it read-only and approval is refused", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    h.clock.now += PLAN_TTL_MS + 1;
    const status = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    })) as { state: string; expired: boolean };
    expect(status.expired).toBe(true);
    expect(status.state).toBe("pending");
    await expectCode(
      h.plane.request(hermes.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      }),
      3,
      "Plan expired",
    );
  });
});

describe("approval", () => {
  test("a different authorized client approves the exact fingerprint", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    const result = (await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    })) as { approval: unknown; operation: { state: string } };
    expect(result.operation.state).toBe("approved");
    expect(schemas.approvalView(json(result.approval))).toBe(true);
    const approval = result.approval as {
      issuer: string;
      approver: string;
      expiresAt: string;
      issuedAt: string;
    };
    expect(approval.issuer).toBe("codex-pc");
    expect(approval.approver).toBe("hermes-admin");
    expect(Date.parse(approval.expiresAt) - Date.parse(approval.issuedAt)).toBe(
      APPROVAL_TTL_MS,
    );
    expect(approval.issuedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(JSON.stringify(result)).not.toContain("nonce");
  });

  test("self-approval is refused and the plan stays pending", async () => {
    const h = await harness();
    const codex = await client(h, {
      ...CODEX,
      scopes: [...CODEX.scopes, "approve:decide"],
    });
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await expectCode(
      h.plane.request(codex.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      }),
      3,
      "Self-approval",
    );
    const status = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    })) as { state: string };
    expect(status.state).toBe("pending");
  });

  test("a client without approve:decide cannot approve", async () => {
    const h = await harness();
    const codex = await client(h, { ...CODEX, id: "codex-two" });
    const other = await client(h, { ...CODEX, id: "codex-three" });
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await expectCode(
      h.plane.request(other.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      }),
      3,
      "Client lacks the scope",
    );
  });

  test("an approver without the host grant is refused as unavailable", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const narrow = await client(h, {
      ...HERMES,
      id: "hermes-narrow",
      hosts: ["lab-printer"],
    });
    const plan = await planOn(h, codex.actor, "nas", CHANGE);
    await expectCode(
      h.plane.request(narrow.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      }),
      3,
      "Operation unavailable",
    );
  });

  test("a mismatched fingerprint is refused", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await expectCode(
      h.plane.request(hermes.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: "0".repeat(64),
        decision: "approve",
      }),
      3,
      "Fingerprint does not match",
    );
  });

  test("a second approval decision is a replay and is refused", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    const approve = () =>
      h.plane.request(hermes.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      });
    await approve();
    await expectCode(approve(), 3, "not awaiting approval");
  });

  test("rejection closes the operation; it cannot be approved or executed", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    const rejected = (await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "reject",
    })) as { state: string; reason: string };
    expect(rejected.state).toBe("failed");
    expect(rejected.reason).toBe("rejected");
    await expectCode(
      h.plane.request(hermes.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      }),
      3,
    );
    await expectCode(
      h.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
      "never retried",
    );
  });

  test("an approval that expires before execution is closed and never runs", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    h.clock.now += APPROVAL_TTL_MS + 1;
    await expectCode(
      h.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
      "failed",
    );
    expect(h.calls).toHaveLength(0);
    const status = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    })) as { state: string; reason: string };
    expect(status.state).toBe("failed");
    expect(status.reason).toBe("approval-expired");
  });
});

describe("execution (local operator only)", () => {
  async function approved(
    h: Harness,
    argv: string[] = CHANGE,
    host = "lab-printer",
  ) {
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, host, argv);
    await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    return { codex, hermes, plan };
  }
  const run = (h: Harness, operationId: string) =>
    h.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId },
    ) as Promise<{
      operation: { state: string; exitCode?: number; spawnAttempted: boolean };
      output?: { stdout: string };
    }>;

  test("an approved operation runs once through the existing exec path and succeeds", async () => {
    const h = await harness();
    const { plan } = await approved(h);
    const result = await run(h, plan.operationId);
    expect(result.operation.state).toBe("succeeded");
    expect(result.operation.exitCode).toBe(0);
    expect(result.operation.spawnAttempted).toBe(true);
    expect(result.output?.stdout).toBe("Linux\n");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.argv).toEqual(CHANGE);
    const audit = await readFile(
      join(h.dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(audit).toContain('"operation.executing"');
    expect(audit).toContain('"operation.succeeded"');
    expect(audit).not.toContain("Linux");
  });

  test("destructive argv passes the existing approval digest check", async () => {
    const h = await harness();
    const { plan } = await approved(h, [
      "rm",
      "-f",
      "/tmp/homectl-slice1-fixture",
    ]);
    const result = await run(h, plan.operationId);
    expect(result.operation.state).toBe("succeeded");
    expect(h.calls[0]?.argv).toEqual([
      "rm",
      "-f",
      "/tmp/homectl-slice1-fixture",
    ]);
  });

  test("replaying execution is refused and nothing runs twice", async () => {
    const h = await harness();
    const { plan } = await approved(h);
    await run(h, plan.operationId);
    await expectCode(run(h, plan.operationId), 3, "never retried");
    expect(h.calls).toHaveLength(1);
  });

  test("an unapproved plan is refused with the confirmation code", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await expectCode(run(h, plan.operationId), 4, "requires approval");
    expect(h.calls).toHaveLength(0);
  });

  test("clients can never execute, whatever their scopes", async () => {
    const h = await harness();
    const { codex, plan } = await approved(h);
    await expectCode(
      h.plane.request(codex.actor, {
        op: "execute",
        operationId: plan.operationId,
      }),
      3,
      "Execution is a local operator action",
    );
    expect(h.calls).toHaveLength(0);
  });

  test("the local operator is limited to execute", async () => {
    const h = await harness();
    const { plan } = await approved(h);
    await expectCode(
      h.plane.request(
        { kind: "local-operator" },
        { op: "status", operationId: plan.operationId },
      ),
      3,
      "limited to execute",
    );
  });

  test("a non-zero exit is recorded as failed, with its exit code, and not retried", async () => {
    const h = await harness(async () => ({
      exitCode: 3,
      stdout: "",
      stderr: "",
    }));
    const { plan } = await approved(h);
    const result = await run(h, plan.operationId);
    expect(result.operation.state).toBe("failed");
    expect(result.operation.exitCode).toBe(3);
    await expectCode(run(h, plan.operationId), 3);
  });

  test("an exception after spawn is recorded as unknown and never retried", async () => {
    let calls = 0;
    const h = await harness(async () => {
      calls++;
      throw new HomectlError(5, "Process could not start");
    });
    const { plan } = await approved(h);
    const result = await run(h, plan.operationId);
    expect(result.operation.state).toBe("unknown");
    expect(result.operation.spawnAttempted).toBe(true);
    await expectCode(run(h, plan.operationId), 3);
    expect(calls).toBe(1);
  });

  test("changed inventory after approval produces stale-plan and no execution", async () => {
    const h = await harness();
    const { plan } = await approved(h);
    const changed = INVENTORY.replace(
      "Test printer host",
      "Edited printer host",
    );
    await writeFile(h.inventoryPath, changed);
    await expectCode(run(h, plan.operationId), 3, "changed since approval");
    expect(h.calls).toHaveLength(0);
    const status = (await h.plane.request(
      { kind: "client", client: await clientIdentity(h, CODEX) } as Actor,
      { op: "status", operationId: plan.operationId },
    )) as { state: string; reason: string };
    expect(status.state).toBe("failed");
    expect(status.reason).toBe("stale-plan");
  });

  test("a policy change that tightens the tier also invalidates the approval", async () => {
    const h = await harness();
    const { plan } = await approved(h);
    await writeFile(
      h.inventoryPath,
      INVENTORY.replace("access: user", "access: observe"),
    );
    await expectCode(run(h, plan.operationId), 3);
    expect(h.calls).toHaveLength(0);
  });

  test("revoking the approver after approval closes the operation before execution", async () => {
    const h = await harness();
    const { plan, hermes } = await approved(h);
    await h.plane.revokeClient("hermes-admin");
    await expectCode(run(h, plan.operationId), 3, "Approver authority changed");
    expect(h.calls).toHaveLength(0);
    expect(hermes.identity.id).toBe("hermes-admin");
  });

  test("an operation record edited on disk fails the integrity check and never runs", async () => {
    const h = await harness();
    const { plan } = await approved(h);
    const path = join(h.dir, "control-plane", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.operations[plan.operationId].plan.argv = ["uname", "-a"];
    await writeFile(path, JSON.stringify(state));
    await expectCode(run(h, plan.operationId), 3, "integrity check");
    expect(h.calls).toHaveLength(0);
  });

  test("an approval transplanted from another operation never passes", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const first = await planOn(h, codex.actor, "lab-printer", CHANGE);
    const second = await planOn(h, codex.actor, "lab-printer", [
      "systemctl",
      "restart",
      "sshd",
    ]);
    for (const plan of [first, second])
      await h.plane.request(hermes.actor, {
        op: "approve",
        operationId: plan.operationId,
        fingerprint: plan.fingerprint,
        decision: "approve",
      });
    const path = join(h.dir, "control-plane", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.operations[second.operationId].approval =
      state.operations[first.operationId].approval;
    await writeFile(path, JSON.stringify(state));
    await expectCode(run(h, second.operationId), 3, "integrity check");
    expect(h.calls).toHaveLength(0);
  });

  test("read-only requests leave operation, approval and client state untouched", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    const dir = join(h.dir, "control-plane");
    const before = await Promise.all(
      ["state.json", "clients.json"].map((f) => readFile(join(dir, f), "utf8")),
    );
    await h.plane.request(codex.actor, { op: "inspect", host: "lab-printer" });
    await h.plane.request(codex.actor, { op: "inspect" });
    await h.plane.request(codex.actor, { op: "status" });
    await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    });
    await h.plane.request(codex.actor, {
      op: "validate",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
    });
    await h.plane.request(codex.actor, {
      op: "verify",
      operationId: plan.operationId,
    });
    const after = await Promise.all(
      ["state.json", "clients.json"].map((f) => readFile(join(dir, f), "utf8")),
    );
    expect(after).toEqual(before);
    expect(h.calls).toHaveLength(0);
    const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"request.accepted"');
  });

  test("concurrent execute requests run the operation exactly once", async () => {
    const h = await harness(async () => {
      await Bun.sleep(50);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const { plan } = await approved(h);
    const settled = await Promise.allSettled([
      run(h, plan.operationId),
      run(h, plan.operationId),
      run(h, plan.operationId),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  test("concurrent approvals by two clients produce exactly one approval", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const second = await client(h, { ...HERMES, id: "hermes-second" });
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    const settled = await Promise.allSettled(
      [hermes, second].map((a) =>
        h.plane.request(a.actor, {
          op: "approve",
          operationId: plan.operationId,
          fingerprint: plan.fingerprint,
          decision: "approve",
        }),
      ),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
  });

  test("consumed nonces are persisted, so a replay after restart is still refused", async () => {
    const h = await harness();
    const { plan } = await approved(h);
    await run(h, plan.operationId);
    const restarted = new ControlPlane({
      inventoryPath: h.inventoryPath,
      configPath: join(h.dir, "ssh_config"),
      stateDirectory: join(h.dir, "control-plane"),
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      clock: () => h.clock.now,
    });
    await restarted.init();
    await expectCode(
      restarted.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
    );
    expect(h.calls).toHaveLength(1);
  });
});

describe("inspection plans run without a second client", () => {
  test("an inspection plan runs once with no approval record, and the journal says so", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const plan = await planOn(h, codex.actor, "lab-printer", ["uname", "-s"]);
    const shown = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    })) as { needsApproval: boolean; approval?: unknown };
    expect(shown.needsApproval).toBe(false);
    expect(shown.approval).toBeUndefined();
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
    expect(audit).toContain('"reason":"no-approval-required"');
    await expectCode(
      h.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: plan.operationId },
      ),
      3,
      "never retried",
    );
    expect(h.calls).toHaveLength(1);
  });

  test("approval is refused for inspection plans, and mutations still need it", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const inspect = await planOn(h, codex.actor, "lab-printer", [
      "uname",
      "-s",
    ]);
    await expectCode(
      h.plane.request(hermes.actor, {
        op: "approve",
        operationId: inspect.operationId,
        fingerprint: inspect.fingerprint,
        decision: "approve",
      }),
      3,
      "need no approval",
    );
    const change = await planOn(h, codex.actor, "lab-printer", CHANGE);
    const shown = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: change.operationId,
    })) as { needsApproval: boolean };
    expect(shown.needsApproval).toBe(true);
    await expectCode(
      h.plane.request(
        { kind: "local-operator" },
        { op: "execute", operationId: change.operationId },
      ),
      4,
      "requires approval",
    );
  });
});

describe("recovery, validation and verification", () => {
  test("an operation left executing by a dead process is closed as unknown on startup", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    const path = join(h.dir, "control-plane", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.operations[plan.operationId].state = "executing";
    state.operations[plan.operationId].executorPid = 2147483646;
    await writeFile(path, JSON.stringify(state));
    await h.plane.init();
    const after = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    })) as { state: string; reason: string; spawnAttempted: boolean };
    expect(after.state).toBe("unknown");
    expect(after.reason).toBe("interrupted");
    expect(after.spawnAttempted).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  test("an executing operation whose executor is alive is left alone on startup", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    const path = join(h.dir, "control-plane", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.operations[plan.operationId].state = "executing";
    state.operations[plan.operationId].executorPid = process.pid;
    await writeFile(path, JSON.stringify(state));
    await h.plane.init();
    const after = (await h.plane.request(codex.actor, {
      op: "status",
      operationId: plan.operationId,
    })) as { state: string };
    expect(after.state).toBe("executing");
  });

  test("validate reports valid for an unchanged plan and drift otherwise", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    const check = (fp: string) =>
      h.plane.request(codex.actor, {
        op: "validate",
        operationId: plan.operationId,
        fingerprint: fp,
      }) as Promise<{ valid: boolean; reason: string }>;
    expect(await check(plan.fingerprint)).toMatchObject({
      valid: true,
      reason: "ok",
    });
    expect(await check("0".repeat(64))).toMatchObject({
      valid: false,
      reason: "fingerprint-mismatch",
    });
    await writeFile(
      h.inventoryPath,
      INVENTORY.replace("Test printer host", "Other host"),
    );
    expect(await check(plan.fingerprint)).toMatchObject({
      valid: false,
      reason: "machine-changed",
    });
  });

  test("verify reports a consistent trail and an intact chain for a succeeded operation", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    await h.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: plan.operationId },
    );
    const verified = (await h.plane.request(codex.actor, {
      op: "verify",
      operationId: plan.operationId,
    })) as { consistent: boolean; journal: { chainValid: boolean } };
    expect(verified.consistent).toBe(true);
    expect(verified.journal.chainValid).toBe(true);
    expect((await h.plane.verifyAudit()).ok).toBe(true);
  });

  test("the journal and client registry never contain token values", async () => {
    const h = await harness();
    const codex = await client(h, CODEX);
    const hermes = await client(h, HERMES);
    const plan = await planOn(h, codex.actor, "lab-printer", CHANGE);
    await h.plane.request(hermes.actor, {
      op: "approve",
      operationId: plan.operationId,
      fingerprint: plan.fingerprint,
      decision: "approve",
    });
    await h.plane.request(
      { kind: "local-operator" },
      { op: "execute", operationId: plan.operationId },
    );
    await h.plane.recordAuthRejection();
    const files = ["audit.jsonl", "state.json", "clients.json"].map((f) =>
      readFile(join(h.dir, "control-plane", f), "utf8"),
    );
    for (const text of await Promise.all(files)) {
      expect(text).not.toContain(codex.token);
      expect(text).not.toContain(hermes.token);
    }
  });
});

async function clientIdentity(
  h: Harness,
  input: { id: string; scopes: string[]; hosts: string[] },
): Promise<ClientIdentity> {
  const found = (await h.plane.listClients()).find((c) => c.id === input.id);
  if (!found) throw new Error("missing client");
  return {
    id: found.id,
    name: found.name,
    scopes: found.scopes,
    hosts: found.hosts,
  };
}
