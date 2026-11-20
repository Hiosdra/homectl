// No automated rule writes (homelab #21 §10, "no automated rule writes"). A
// reviewer allow, a rules-mode allow and a one-time approval must leave the
// owner's policy file byte-identical, or keep it absent. Only an explicit owner
// "remember" may write a rule; the last test is that positive control.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Reviewer, defaultPolicy } from "../src/authz";
import { NonceLedger } from "../src/approvals/ledger";
import { AuthzPolicy } from "../src/broker/authz-policy";
import { Broker } from "../src/broker/engine";
import { BrokerStore } from "../src/broker/store";
import type { EventsPort, ExecutorPort } from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import { OWNER, type PolicyDocument, type Rule } from "../src/core/contracts";
import type { Machine } from "../src/types";

const clock = 1_800_000_000_000;
const now = () => clock;
const restart = ["systemctl", "restart", "nginx"];
const agent: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["nas"],
};
const machines: Record<string, Machine> = {
  nas: { description: "NAS", transport: "ssh", access: "full", user: "admin" },
};
const allowRestart: Rule = {
  id: "owner-restart",
  effect: "allow",
  match: {
    clients: ["codex-pc"],
    hosts: ["nas"],
    kinds: ["exec"],
    argvExact: [restart],
    maxRisk: "R2",
  },
  createdAt: clock,
  createdBy: OWNER,
};

let dir: string;
let path: string;
let executed: string[][];
const brokers: Broker[] = [];
const executor: ExecutorPort = {
  run: async ({ argv }) => {
    executed.push(argv);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  },
};
const events: EventsPort = { emit: async () => undefined };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-policy-writes-"));
  path = join(dir, "policy.json");
  executed = [];
});
afterEach(async () => {
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

// The file's exact bytes, or "absent". Compared as base64 so a failure prints
// something readable.
async function snapshot(): Promise<string> {
  try {
    return (await readFile(path)).toString("base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

async function build(options: {
  doc?: PolicyDocument;
  reviewer?: Reviewer;
}): Promise<Broker> {
  const policy = new AuthzPolicy({
    path,
    now,
    ...(options.reviewer ? { reviewer: async () => options.reviewer } : {}),
    reviewerTimeoutMs: 2000,
  });
  if (options.doc) await policy.save(options.doc);
  const broker = new Broker({
    store: new BrokerStore(dir),
    ledger: new NonceLedger(dir, now),
    key: await loadOrCreateDeviceKey(dir),
    device: { id: "dev-test-0000000000", name: "test" },
    policy,
    inventory: {
      machine: async (h) => machines[h],
      hosts: async () => Object.keys(machines),
    },
    executor,
    events,
    now,
  });
  await broker.init();
  brokers.push(broker);
  return broker;
}

const autoDoc = (authority: "routine" | "recommend") => ({
  ...defaultPolicy("routine", clock),
  mode: "auto" as const,
  reviewer: {
    authority,
    fallback: "ask" as const,
    maxRisk: "R2" as const,
    provider: "openai-compatible" as const,
  },
});

const rulesDoc = (rules: Rule[] = []): PolicyDocument => {
  const base = defaultPolicy("routine", clock);
  return { ...base, mode: "rules", rules: [...base.rules, ...rules] };
};

const allowReviewer: Reviewer = {
  id: "test",
  review: async () => ({ verdict: "allow", reason: "routine change" }),
};

describe("no automated rule writes", () => {
  test("a reviewer allow leaves the policy file byte-identical", async () => {
    const broker = await build({
      doc: autoDoc("routine"),
      reviewer: allowReviewer,
    });
    const before = await snapshot();
    const view = await broker.exec(agent, { host: "nas", argv: restart });
    await broker.settled();
    const op = await broker.operation(view.id);
    expect(op?.state).toBe("succeeded");
    expect(op?.decision.source).toBe("reviewer");
    expect(executed).toEqual([restart]);
    expect(await snapshot()).toBe(before);
  });

  test("a rules-mode allow leaves the policy file byte-identical", async () => {
    const broker = await build({ doc: rulesDoc([allowRestart]) });
    const before = await snapshot();
    const view = await broker.exec(agent, { host: "nas", argv: restart });
    await broker.settled();
    const op = await broker.operation(view.id);
    expect(op?.decision.source).toBe("rule");
    expect(op?.state).toBe("succeeded");
    expect(await snapshot()).toBe(before);
  });

  test("approve-once leaves the policy file byte-identical", async () => {
    const broker = await build({ doc: rulesDoc() });
    const before = await snapshot();
    const view = await broker.exec(agent, { host: "nas", argv: restart });
    expect(view.state).toBe("awaiting-approval");
    await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: true,
    });
    await broker.settled();
    const op = await broker.operation(view.id);
    expect(op?.state).toBe("succeeded");
    expect(op?.rememberedRule).toBeUndefined();
    expect(executed).toEqual([restart]);
    expect(await snapshot()).toBe(before);
  });

  test("approve-once with no policy file leaves the file absent", async () => {
    const broker = await build({});
    expect(await snapshot()).toBe("absent");
    const view = await broker.exec(agent, { host: "nas", argv: restart });
    expect(view.state).toBe("awaiting-approval");
    await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: true,
    });
    await broker.settled();
    expect((await broker.operation(view.id))?.state).toBe("succeeded");
    expect(await snapshot()).toBe("absent");
  });

  test("a reviewer allow with no policy file keeps it absent, and nothing runs silently", async () => {
    // No auto mode without a file: the default preset never consults the
    // reviewer, so the owner is asked and nothing runs.
    const broker = await build({ reviewer: allowReviewer });
    const view = await broker.exec(agent, { host: "nas", argv: restart });
    await broker.settled();
    expect((await broker.operation(view.id))?.state).toBe("awaiting-approval");
    expect(executed).toEqual([]);
    expect(await snapshot()).toBe("absent");
  });

  test("positive control: an explicit owner remember does write the file", async () => {
    const broker = await build({ doc: rulesDoc() });
    const before = await snapshot();
    const view = await broker.exec(agent, { host: "nas", argv: restart });
    await broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-remember",
      surface: "panel",
      stepUp: true,
    });
    await broker.settled();
    const op = await broker.operation(view.id);
    expect(op?.rememberedRule).toBeDefined();
    const after = await snapshot();
    expect(after).not.toBe(before);
    const saved = JSON.parse(
      (await readFile(path)).toString("utf8"),
    ) as PolicyDocument;
    expect(saved.rules.map((rule) => rule.id)).toContain(
      op?.rememberedRule ?? "",
    );
  });
});
