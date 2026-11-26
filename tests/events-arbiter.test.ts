import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionArbiter, type DecisionInput } from "../src/events";

async function tempDir(
  label: string,
): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), `homectl-events-${label}-`));
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(label: string): Promise<string> {
  const { directory, cleanup } = await tempDir(label);
  cleanups.push(cleanup);
  return directory;
}

function decision(
  operationId: string,
  overrides: Partial<DecisionInput> = {},
): DecisionInput {
  return {
    operationId,
    decision: "approve",
    surface: "phone",
    nonce: `nonce-${operationId}-approve`,
    at: 1000,
    fingerprint: "fp-1",
    ...overrides,
  };
}

const FUTURE = 10_000;

describe("DecisionArbiter", () => {
  test("first valid decision wins; a conflicting late decision is rejected", async () => {
    const arbiter = new DecisionArbiter({
      directory: await fixture("late"),
      now: () => 1000,
    });
    await arbiter.register("op-1", "fp-1", FUTURE);
    const first = await arbiter.decide(decision("op-1"));
    expect(first.accepted).toBe(true);

    const late = await arbiter.decide(
      decision("op-1", {
        decision: "deny",
        surface: "server",
        nonce: "nonce-late-deny-01",
      }),
    );
    expect(late.accepted).toBe(false);
    if (late.accepted) throw new Error("unreachable");
    expect(late.reason).toBe("already-decided");
    expect(late.record?.decision).toBe("approve");
    expect(late.record?.surface).toBe("phone");
  });

  test("the same nonce repeated is an idempotent duplicate with the original record", async () => {
    const arbiter = new DecisionArbiter({
      directory: await fixture("dup"),
      now: () => 1000,
    });
    await arbiter.register("op-2", "fp-1", FUTURE);
    const original = await arbiter.decide(decision("op-2"));
    const repeat = await arbiter.decide(decision("op-2"));
    expect(repeat.accepted).toBe(false);
    if (repeat.accepted || original.accepted === false)
      throw new Error("unexpected result");
    expect(repeat.reason).toBe("duplicate");
    expect(repeat.record).toEqual(original.record);
  });

  test("two concurrent decide() calls on one instance yield exactly one accepted", async () => {
    const arbiter = new DecisionArbiter({
      directory: await fixture("concurrent-one"),
      now: () => 1000,
    });
    await arbiter.register("op-3", "fp-1", FUTURE);
    const results = await Promise.all([
      arbiter.decide(
        decision("op-3", { surface: "phone", nonce: "nonce-phone-0001" }),
      ),
      arbiter.decide(
        decision("op-3", {
          surface: "server",
          nonce: "nonce-server-0001",
          decision: "deny",
        }),
      ),
    ]);
    expect(results.filter((r) => r.accepted).length).toBe(1);
    const loser = results.find((r) => !r.accepted);
    expect(loser && !loser.accepted && loser.reason).toBe("already-decided");
  });

  test("two separate instances on the same directory yield exactly one accepted", async () => {
    const directory = await fixture("concurrent-two");
    const a = new DecisionArbiter({ directory, now: () => 1000 });
    const b = new DecisionArbiter({ directory, now: () => 1000 });
    for (let round = 0; round < 5; round++) {
      const operationId = `race-${round}`;
      await a.register(operationId, "fp-1", FUTURE);
      const results = await Promise.all([
        a.decide(
          decision(operationId, {
            surface: "phone",
            nonce: `nonce-a-${round}-xxxxxxxx`,
          }),
        ),
        b.decide(
          decision(operationId, {
            surface: "server",
            nonce: `nonce-b-${round}-xxxxxxxx`,
            decision: "deny",
          }),
        ),
      ]);
      expect(results.filter((r) => r.accepted).length).toBe(1);
    }
  }, 60_000);

  test("a fingerprint mismatch is rejected and does not consume the operation", async () => {
    const arbiter = new DecisionArbiter({
      directory: await fixture("fingerprint"),
      now: () => 1000,
    });
    await arbiter.register("op-4", "fp-1", FUTURE);
    const wrong = await arbiter.decide(
      decision("op-4", { fingerprint: "fp-other" }),
    );
    expect(wrong.accepted).toBe(false);
    if (wrong.accepted) throw new Error("unreachable");
    expect(wrong.reason).toBe("fingerprint-mismatch");
    const right = await arbiter.decide(decision("op-4"));
    expect(right.accepted).toBe(true);
  });

  test("decisions after expiry are rejected; unknown operations are rejected", async () => {
    let now = 1000;
    const arbiter = new DecisionArbiter({
      directory: await fixture("expired"),
      now: () => now,
    });
    await arbiter.register("op-5", "fp-1", 2000);
    now = 2001;
    const expired = await arbiter.decide(decision("op-5"));
    expect(expired).toEqual({ accepted: false, reason: "expired" });

    const unknown = await arbiter.decide(decision("never-registered"));
    expect(unknown).toEqual({ accepted: false, reason: "unknown-operation" });
  });

  test("register is idempotent for the same fingerprint and rejects a different one", async () => {
    const arbiter = new DecisionArbiter({
      directory: await fixture("register"),
      now: () => 1000,
    });
    await arbiter.register("op-6", "fp-1", FUTURE);
    await arbiter.register("op-6", "fp-1", FUTURE);
    await expect(arbiter.register("op-6", "fp-2", FUTURE)).rejects.toThrow();
  });

  test("a decision survives a new instance reading the same directory", async () => {
    const directory = await fixture("persist");
    const first = new DecisionArbiter({ directory, now: () => 1000 });
    await first.register("op-7", "fp-1", FUTURE);
    await first.decide(decision("op-7"));
    const second = new DecisionArbiter({ directory, now: () => 1000 });
    const late = await second.decide(
      decision("op-7", { nonce: "nonce-after-restart", decision: "deny" }),
    );
    expect(late.accepted).toBe(false);
    if (late.accepted) throw new Error("unreachable");
    expect(late.reason).toBe("already-decided");
  });
});
