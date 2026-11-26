// Reviewer verdicts are reached with the state lock released (homelab #21 §4,
// §7): a slow reviewer blocks nothing, an owner decision made while the review
// runs wins, and a policy change during the review makes the verdict stale.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "../src/approvals/ledger";
import { type Reviewer, type ReviewerInput, defaultPolicy } from "../src/authz";
import { AuthzPolicy } from "../src/broker/authz-policy";
import { Broker } from "../src/broker/engine";
import { BrokerStore } from "../src/broker/store";
import type { ExecutorPort } from "../src/broker/types";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";
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
const allow = { verdict: "allow", reason: "routine change" };
const restart = (service: string) => ({
  host: "nas",
  argv: ["systemctl", "restart", service],
});

let dir: string;
let executed: string[][];
const brokers: Broker[] = [];
const gates: Array<() => void> = [];
const executor: ExecutorPort = {
  run: async ({ argv }) => {
    executed.push(argv);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-engine-review-"));
  executed = [];
});
afterEach(async () => {
  // A reviewer still waiting must not outlive its test.
  for (const open of gates.splice(0)) open();
  for (const b of brokers.splice(0))
    await Promise.race([b.settled(), Bun.sleep(500)]);
  await rm(dir, { recursive: true, force: true });
});

// A reviewer the test controls: `opened` resolves once the test releases it.
function gate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.push(release);
  return { opened, release };
}

type Answer = (
  input: ReviewerInput,
  call: number,
  policy: AuthzPolicy,
) => unknown;

async function build(policy: AuthzPolicy): Promise<Broker> {
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
    now,
  });
  await broker.init();
  brokers.push(broker);
  return broker;
}

// An Auto-mode broker (routine authority) whose reviewer answers `answer`.
async function harness(answer: Answer) {
  const reviews: ReviewerInput[] = [];
  const reviewer: Reviewer = {
    id: "test",
    review: async (input) => {
      reviews.push(input);
      return answer(input, reviews.length, policy);
    },
  };
  const policy = new AuthzPolicy({
    path: join(dir, "policy.json"),
    now,
    reviewer: async () => reviewer,
    reviewerTimeoutMs: 5000,
  });
  const base = defaultPolicy("routine", clock);
  await policy.save({
    ...base,
    mode: "auto",
    reviewer: {
      authority: "routine",
      fallback: "ask",
      maxRisk: "R2",
      provider: "openai-compatible",
    },
  });
  const broker = await build(policy);
  return { broker, policy, reviews };
}

// Waits until `check` holds; fails instead of hanging.
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition was not reached");
    await Bun.sleep(5);
  }
}

// Fails if `work` is still pending after `ms`: a blocked broker shows up here.
async function within<T>(work: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("blocked behind a slow reviewer")),
      ms,
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe("the policy runs outside the state lock", () => {
  test("a slow reviewer does not block another submit, read or decide", async () => {
    const slow = gate();
    const h = await harness(async (input) => {
      if (input.argv?.includes("nginx")) await slow.opened;
      if (input.argv?.includes("redis"))
        return { verdict: "ask", reason: "owner please" };
      return allow;
    });
    const waiting = h.broker.exec(agent, restart("nginx"));
    await until(() => h.reviews.some((r) => r.argv?.includes("nginx")));

    // The nginx review is still running; everything else goes through.
    const queued = await within(h.broker.exec(agent, restart("redis")));
    expect(queued.state).toBe("awaiting-approval");
    const read = await within(h.broker.status(agent, queued.id));
    expect(read.state).toBe("awaiting-approval");
    const decided = await within(
      h.broker.decide({
        operationId: queued.id,
        fingerprint: queued.fingerprint,
        decision: "approve-once",
        surface: "panel",
        stepUp: false,
      }),
    );
    expect(decided.grant?.operationId).toBe(queued.id);
    await within(h.broker.settled());

    slow.release();
    const slowView = await within(waiting);
    await within(h.broker.settled());
    expect((await h.broker.status(agent, slowView.id)).state).toBe("succeeded");
    expect(executed.map((argv) => argv[2]).sort()).toEqual(["nginx", "redis"]);
  });

  test("an owner decision made during the review wins and the verdict is dropped", async () => {
    const slow = gate();
    const h = await harness(async () => {
      await slow.opened;
      return allow;
    });
    const waiting = h.broker.exec(agent, restart("nginx"));
    await until(() => h.reviews.length === 1);
    const [pending] = await h.broker.pending();
    expect(pending?.state).toBe("awaiting-approval");

    const decided = await within(
      h.broker.decide({
        operationId: pending?.id ?? "",
        fingerprint: pending?.fingerprint ?? "",
        decision: "approve-once",
        surface: "panel",
        stepUp: false,
      }),
    );
    expect(decided.grant?.operationId).toBe(pending?.id);
    await within(h.broker.settled());

    slow.release();
    const view = await within(waiting);
    await within(h.broker.settled());
    // Dispatched once, by the owner; the reviewer's allow was not committed.
    expect(executed).toEqual([["systemctl", "restart", "nginx"]]);
    expect(view.id).toBe(pending?.id ?? "");
    const op = await h.broker.operation(view.id);
    expect(op?.state).toBe("succeeded");
    expect(op?.approvedBy?.surface).toBe("panel");
    expect(op?.decision.source).not.toBe("reviewer");
    expect(op?.decision.reason).toContain("reviewer verdict was dropped");
    expect(h.reviews.length).toBe(1);
  });

  test("approve-and-remember is refused while the review is still running", async () => {
    const slow = gate();
    const h = await harness(async () => {
      await slow.opened;
      return allow;
    });
    const waiting = h.broker.exec(agent, restart("nginx"));
    await until(() => h.reviews.length === 1);
    const [pending] = await h.broker.pending();
    await expect(
      h.broker.decide({
        operationId: pending?.id ?? "",
        fingerprint: pending?.fingerprint ?? "",
        decision: "approve-remember",
        surface: "panel",
        stepUp: false,
      }),
    ).rejects.toThrow("still being reviewed");

    slow.release();
    const view = await within(waiting);
    await within(h.broker.settled());
    expect(view.state).not.toBe("denied");
    expect(executed).toEqual([["systemctl", "restart", "nginx"]]);
    expect((await h.broker.operation(view.id))?.rememberedRule).toBeUndefined();
  });

  test("an operation under review carries source review until its verdict lands", async () => {
    const slow = gate();
    const h = await harness(async () => {
      await slow.opened;
      return allow;
    });
    const waiting = h.broker.exec(agent, restart("nginx"));
    await until(() => h.reviews.length === 1);
    const [pending] = await h.broker.pending();
    expect(pending?.decision.source).toBe("review");
    expect(pending?.decision.verdict).toBe("ask");

    slow.release();
    const view = await within(waiting);
    await within(h.broker.settled());
    const op = await h.broker.operation(view.id);
    expect(op?.decision.source).toBe("reviewer");
    expect(op?.decision.verdict).toBe("allow");
  });

  test("an operation recorded by an older build is still recognised as under review on restart", async () => {
    const slow = gate();
    const h = await harness(async () => {
      await slow.opened;
      return allow;
    });
    const waiting = h.broker.exec(agent, restart("nginx"));
    await until(() => h.reviews.length === 1);
    const [pending] = await h.broker.pending();
    const id = pending?.id ?? "";
    // The record as an earlier build wrote it: default source, reason text only.
    await new BrokerStore(dir).update((state) => {
      const op = state.operations[id];
      if (op) op.decision = { ...op.decision, source: "default" };
    });

    await build(h.policy);
    const after = await new BrokerStore(dir).load();
    expect(after.operations[id]?.state).toBe("cancelled");
    expect(after.operations[id]?.reason).toBe("review-interrupted");

    slow.release();
    await within(waiting);
    await within(h.broker.settled());
    expect(executed).toEqual([]);
  });

  test("a policy change during the review makes the verdict stale and re-evaluates", async () => {
    const slow = gate();
    const h = await harness(async (_input, call) => {
      if (call === 1) await slow.opened;
      return allow;
    });
    const waiting = h.broker.exec(agent, restart("nginx"));
    await until(() => h.reviews.length === 1);
    // An owner saves the policy (a new revision) while the reviewer runs.
    await h.policy.save(await h.policy.document());
    slow.release();

    const view = await within(waiting);
    await within(h.broker.settled());
    expect(h.reviews.length).toBe(2);
    expect(executed).toEqual([["systemctl", "restart", "nginx"]]);
    const op = await h.broker.operation(view.id);
    expect(op?.decision.policyRevision).toBe(await h.policy.revision());
    expect(op?.decision.modelCalls).toBe(2);
  });

  test("a policy that keeps changing ends with the owner deciding, never an allow", async () => {
    const h = await harness(async (_input, _call, policy) => {
      await policy.save(await policy.document());
      return allow;
    });
    const view = await within(h.broker.exec(agent, restart("nginx")));
    expect(h.reviews.length).toBe(3);
    expect(view.state).toBe("awaiting-approval");
    expect(executed).toEqual([]);
    const op = await h.broker.operation(view.id);
    expect(op?.decision.reason).toContain("policy changed");
    expect(op?.decision.modelCalls).toBe(3);

    // Still the owner's call: an approval now runs it exactly once.
    await h.broker.decide({
      operationId: view.id,
      fingerprint: view.fingerprint,
      decision: "approve-once",
      surface: "panel",
      stepUp: false,
    });
    await within(h.broker.settled());
    expect(executed).toEqual([["systemctl", "restart", "nginx"]]);
  });

  test("a restart cancels a review that was still running; the late verdict is dropped", async () => {
    const slow = gate();
    const h = await harness(async () => {
      await slow.opened;
      return allow;
    });
    const waiting = h.broker.exec(agent, restart("nginx"));
    await until(() => h.reviews.length === 1);
    const [pending] = await h.broker.pending();

    const restarted = await build(h.policy);
    const after = await restarted.operation(pending?.id ?? "");
    expect(after?.state).toBe("cancelled");
    expect(after?.reason).toBe("review-interrupted");

    slow.release();
    const view = await within(waiting);
    expect(view.state).toBe("cancelled");
    await within(h.broker.settled());
    expect(executed).toEqual([]);
  });
});
