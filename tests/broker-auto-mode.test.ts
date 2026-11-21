// Auto Mode (homelab #21 A1/A2): the reviewer decides only what no rule covers,
// its verdict never counts as human approval, human-only and R3+ requests never
// reach it, and widening its authority needs the owner password.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPolicy,
  evaluate,
  type Reviewer,
  type ReviewerInput,
} from "../src/authz";
import { NonceLedger } from "../src/approvals/ledger";
import { AuthzPolicy } from "../src/broker/authz-policy";
import { Broker } from "../src/broker/engine";
import { BrokerStore } from "../src/broker/store";
import type { EventsPort, ExecutorPort } from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
import {
  type ActionRequest,
  OWNER,
  type PolicyMode,
  type ReviewerAuthority,
  type Rule,
} from "../src/core/contracts";
import type { Machine } from "../src/types";

const clock = 1_800_000_000_000;
const now = () => clock;
const agent: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["nas"],
};
const machines: Record<string, Machine> = {
  nas: { description: "NAS", transport: "ssh", access: "full", user: "admin" },
};

let dir: string;
let executed: string[][];
const brokers: Broker[] = [];
const executor: ExecutorPort = {
  run: async ({ argv }) => {
    executed.push(argv);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-auto-mode-"));
  executed = [];
});
afterEach(async () => {
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

type Answer = (input: ReviewerInput) => unknown;
const allow: Answer = () => ({ verdict: "allow", reason: "routine change" });
const hang: Answer = () => new Promise<never>(() => undefined);

interface Harness {
  broker: Broker;
  policy: AuthzPolicy;
  events: { type: string; data: Record<string, unknown> }[];
  calls: ReviewerInput[];
}

// A broker in Auto mode with a fake reviewer. `answer` decides what it returns.
async function harness(options: {
  authority: ReviewerAuthority;
  mode?: PolicyMode;
  fallback?: "ask" | "deny";
  answer?: Answer;
  rules?: Rule[];
  timeoutMs?: number;
}): Promise<Harness> {
  const calls: ReviewerInput[] = [];
  const answer = options.answer ?? allow;
  const reviewer: Reviewer = {
    id: "test",
    review: async (input) => {
      calls.push(input);
      return answer(input);
    },
  };
  const policy = new AuthzPolicy({
    path: join(dir, "policy.json"),
    now,
    reviewer: async () => reviewer,
    reviewerTimeoutMs: options.timeoutMs ?? 2000,
  });
  const base = defaultPolicy("routine", clock);
  await policy.save({
    ...base,
    mode: options.mode ?? "auto",
    reviewer: {
      authority: options.authority,
      fallback: options.fallback ?? "ask",
      maxRisk: "R2",
      provider: "openai-compatible",
    },
    rules: [...base.rules, ...(options.rules ?? [])],
  });
  const events: Harness["events"] = [];
  const port: EventsPort = {
    emit: async (type, _subject, _audience, data) => {
      events.push({ type, data });
    },
  };
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
    events: port,
    now,
  });
  await broker.init();
  brokers.push(broker);
  return { broker, policy, events, calls };
}

const restart = ["systemctl", "restart", "nginx"];

describe("reviewer verdicts through the broker", () => {
  test("a reviewer allow dispatches a routine change, but is not a human approval", async () => {
    const h = await harness({ authority: "routine" });
    const view = await h.broker.exec(agent, { host: "nas", argv: restart });
    await h.broker.settled();
    const op = await h.broker.operation(view.id);
    expect(op?.state).toBe("succeeded");
    expect(op?.decision.source).toBe("reviewer");
    expect(op?.decision.modelCalls).toBe(1);
    expect(op?.approvedBy).toBeUndefined();
    expect(executed).toEqual([restart]);
    // The reviewer's words are model output: they never reach the record.
    expect(JSON.stringify(op)).not.toContain("routine change");
    const audit = h.events.find(
      (e) => e.type === "operation.updated" && e.data.source === "reviewer",
    );
    expect(audit?.data).toMatchObject({
      verdict: "allow",
      modelCalls: 1,
      client: "codex-pc",
    });
  });

  test("a reviewer deny is final and nothing runs", async () => {
    const h = await harness({
      authority: "routine",
      answer: () => ({ verdict: "deny", reason: "no" }),
    });
    const view = await h.broker.exec(agent, { host: "nas", argv: restart });
    await h.broker.settled();
    expect((await h.broker.operation(view.id))?.state).toBe("denied");
    expect(executed).toEqual([]);
  });

  test("a reviewer timeout falls back to the owner", async () => {
    const h = await harness({
      authority: "routine",
      answer: hang,
      timeoutMs: 50,
    });
    const view = await h.broker.exec(agent, { host: "nas", argv: restart });
    const op = await h.broker.operation(view.id);
    expect(op?.state).toBe("awaiting-approval");
    expect(op?.decision.source).toBe("default");
    expect(op?.decision.modelCalls).toBe(1);
    expect(executed).toEqual([]);
  });

  test("a reviewer timeout denies when the fallback is deny", async () => {
    const h = await harness({
      authority: "routine",
      answer: hang,
      fallback: "deny",
      timeoutMs: 50,
    });
    const view = await h.broker.exec(agent, { host: "nas", argv: restart });
    expect((await h.broker.operation(view.id))?.state).toBe("denied");
  });

  test("malformed reviewer output falls back to the owner", async () => {
    const root = dir;
    const answers: unknown[] = [
      "allow",
      { verdict: "allow", reason: "ok", extra: true },
      { verdict: "maybe", reason: "ok" },
      { verdict: "allow" },
    ];
    for (const [index, answer] of answers.entries()) {
      // Each case gets its own policy file and broker state.
      dir = join(root, `case-${index}`);
      await mkdir(dir, { recursive: true });
      const h = await harness({ authority: "delegated", answer: () => answer });
      const view = await h.broker.exec(agent, { host: "nas", argv: restart });
      const op = await h.broker.operation(view.id);
      expect(op?.state).toBe("awaiting-approval");
      expect(op?.decision.source).toBe("default");
    }
    dir = root;
  });

  test("recommend authority never lets the reviewer decide", async () => {
    const h = await harness({ authority: "recommend" });
    const view = await h.broker.exec(agent, { host: "nas", argv: restart });
    const op = await h.broker.operation(view.id);
    expect(op?.state).toBe("awaiting-approval");
    expect(op?.decision.source).toBe("reviewer");
    expect(h.calls).toHaveLength(1);
  });

  test("Rules-only mode never calls the reviewer", async () => {
    const h = await harness({ authority: "delegated", mode: "rules" });
    const view = await h.broker.exec(agent, { host: "nas", argv: restart });
    expect((await h.broker.operation(view.id))?.state).toBe(
      "awaiting-approval",
    );
    expect(h.calls).toHaveLength(0);
  });

  test("a rule that resolves the request makes zero model calls", async () => {
    const rule: Rule = {
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
    const h = await harness({
      authority: "delegated",
      answer: () => {
        throw new Error("must not be asked");
      },
      rules: [rule],
    });
    const view = await h.broker.exec(agent, { host: "nas", argv: restart });
    await h.broker.settled();
    const op = await h.broker.operation(view.id);
    expect(op?.decision.source).toBe("rule");
    expect(op?.decision.modelCalls).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(executed).toEqual([restart]);
  });

  test("an R3 request needs the owner: the reviewer is never asked", async () => {
    const h = await harness({ authority: "delegated" });
    const argv = ["./rotate-keys.sh"];
    const view = await h.broker.exec(agent, { host: "nas", argv });
    const op = await h.broker.operation(view.id);
    expect(op?.state).toBe("awaiting-approval");
    expect(op?.decision.humanOnly).toBe(true);
    expect(op?.decision.stepUp).toBe(true);
    expect(op?.decision.modelCalls).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(executed).toEqual([]);
  });
});

describe("human-only and high-risk requests are never auto-approved", () => {
  const policy = () => ({
    ...defaultPolicy("delegated", clock),
    mode: "auto" as const,
    reviewer: {
      authority: "delegated" as const,
      fallback: "ask" as const,
      maxRisk: "R2" as const,
      provider: "openai-compatible",
    },
  });
  const context = {
    clientRiskPoints: 0,
    knownHost: true,
    now: clock,
  };

  test("human-only kinds ask the owner even when the reviewer always allows", async () => {
    const calls: ReviewerInput[] = [];
    const reviewer: Reviewer = {
      id: "always-allow",
      review: async (input) => {
        calls.push(input);
        return { verdict: "allow", reason: "fine" };
      },
    };
    for (const kind of [
      "host.grant",
      "credential.export",
      "secret.raw",
      "policy.change",
    ] as const) {
      const req: ActionRequest = { client: "codex-pc", kind, risk: "R2" };
      const decision = await evaluate(req, {
        ...context,
        policy: policy(),
        reviewer,
      });
      expect(decision.verdict).toBe("ask");
      expect(decision.humanOnly).toBe(true);
      expect(decision.modelCalls).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  test("R4 exec asks the owner and never reaches the reviewer", async () => {
    const reviewer: Reviewer = {
      id: "always-allow",
      review: async () => ({ verdict: "allow", reason: "fine" }),
    };
    const req: ActionRequest = {
      client: "codex-pc",
      kind: "exec",
      host: "nas",
      argv: ["mkfs.ext4", "/dev/sdb1"],
      classification: "destructive",
      risk: "R4",
    };
    const decision = await evaluate(req, {
      ...context,
      policy: policy(),
      reviewer,
    });
    expect(decision.verdict).toBe("ask");
    expect(decision.modelCalls).toBe(0);
  });
});
