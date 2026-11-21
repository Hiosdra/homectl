import { describe, expect, test } from "bun:test";
import {
  defaultPolicy,
  type EvaluateContext,
  evaluate,
  type Reviewer,
  type ReviewerInput,
} from "../src/authz";
import type {
  ActionRequest,
  PolicyDocument,
  Rule,
} from "../src/core/contracts";

const NOW = Date.parse("2026-11-19T12:00:00Z");

function req(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    client: "agent-a",
    kind: "exec",
    host: "lab-printer",
    argv: ["systemctl", "restart", "klipper"],
    classification: "mutation",
    risk: "R2",
    ...overrides,
  };
}

function rule(id: string, effect: Rule["effect"], match: Rule["match"]): Rule {
  return { id, effect, match, createdAt: 0, createdBy: "owner" };
}

function withPolicy(
  overrides: Partial<PolicyDocument> = {},
  preset: "conservative" | "routine" | "delegated" = "routine",
): PolicyDocument {
  return { ...defaultPolicy(preset, 0), revision: 7, ...overrides };
}

function autoPolicy(
  maxRisk: PolicyDocument["reviewer"]["maxRisk"] = "R2",
): PolicyDocument {
  const base = withPolicy({}, "delegated");
  return {
    ...base,
    mode: "auto",
    reviewer: { ...base.reviewer, provider: "test-model", maxRisk },
  };
}

function ctx(overrides: Partial<EvaluateContext> = {}): EvaluateContext {
  return {
    policy: withPolicy(),
    clientRiskPoints: 0,
    knownHost: true,
    now: NOW,
    ...overrides,
  };
}

function countingReviewer(answer: () => Promise<unknown> | unknown): {
  reviewer: Reviewer;
  calls: () => number;
  inputs: ReviewerInput[];
} {
  const inputs: ReviewerInput[] = [];
  let count = 0;
  return {
    reviewer: {
      id: "stub",
      async review(input) {
        count += 1;
        inputs.push(input);
        return answer();
      },
    },
    calls: () => count,
    inputs,
  };
}

const ALLOW_ANY_REVIEW = () => ({ verdict: "allow", reason: "looks fine" });

describe("invariants", () => {
  test("unknown host is denied before any other step", async () => {
    const decision = await evaluate(req(), ctx({ knownHost: false }));
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("invariant");
    expect(decision.modelCalls).toBe(0);
  });

  test("exec without argv is denied", async () => {
    const decision = await evaluate(req({ argv: undefined }), ctx());
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("invariant");
  });

  test("argv items with NUL, CR or LF are denied", async () => {
    for (const bad of ["a\0b", "a\rb", "a\nb"]) {
      const decision = await evaluate(req({ argv: ["ls", bad] }), ctx());
      expect(decision.verdict).toBe("deny");
      expect(decision.source).toBe("invariant");
    }
  });

  test("the owner identity can never be used as a client", async () => {
    const decision = await evaluate(req({ client: "owner" }), ctx());
    expect(decision.verdict).toBe("deny");
    expect(decision.source).toBe("invariant");
  });
});

describe("hard gates", () => {
  test("a human-only kind asks with step-up even under an allow rule and an always-allow reviewer", async () => {
    const stub = countingReviewer(ALLOW_ANY_REVIEW);
    const policy = autoPolicy("R4");
    policy.rules.push(
      rule("allow-grant", "allow", {
        clients: ["agent-a"],
        kinds: ["host.grant"],
      }),
    );
    const decision = await evaluate(
      req({
        kind: "host.grant",
        argv: undefined,
        host: "lab-printer",
        risk: "R2",
      }),
      ctx({ policy, reviewer: stub.reviewer }),
    );
    expect(decision.verdict).toBe("ask");
    expect(decision.source).toBe("hard-gate");
    expect(decision.humanOnly).toBe(true);
    expect(decision.stepUp).toBe(true);
    expect(stub.calls()).toBe(0);
  });

  test("R4 is never allowed by a rule, even one with maxRisk R4", async () => {
    const policy = withPolicy();
    policy.rules.push(
      rule("allow-all-r4", "allow", { clients: ["agent-a"], maxRisk: "R4" }),
    );
    const decision = await evaluate(req({ risk: "R4" }), ctx({ policy }));
    expect(decision.verdict).toBe("ask");
    expect(decision.source).toBe("hard-gate");
    expect(decision.humanOnly).toBe(true);
    expect(decision.stepUp).toBe(true);
  });

  test("R4 stays held even when the reviewer would allow it", async () => {
    const stub = countingReviewer(ALLOW_ANY_REVIEW);
    const decision = await evaluate(
      req({ risk: "R4" }),
      ctx({ policy: autoPolicy("R4"), reviewer: stub.reviewer }),
    );
    expect(decision.verdict).toBe("ask");
    expect(decision.humanOnly).toBe(true);
    expect(stub.calls()).toBe(0);
  });

  test("R3 asks the owner unless an allow rule names maxRisk exactly R3", async () => {
    const without = await evaluate(req({ risk: "R3" }), ctx());
    expect(without.verdict).toBe("ask");
    expect(without.source).toBe("hard-gate");
    expect(without.humanOnly).toBe(true);
    expect(without.stepUp).toBe(true);

    const policy = withPolicy();
    policy.rules.push(
      rule("r3-printer", "allow", { hosts: ["lab-printer"], maxRisk: "R3" }),
    );
    const allowed = await evaluate(req({ risk: "R3" }), ctx({ policy }));
    expect(allowed.verdict).toBe("allow");
    expect(allowed.source).toBe("rule");
    expect(allowed.ruleId).toBe("r3-printer");
  });

  test("an allow rule capped at R2 does not cover R3", async () => {
    const policy = withPolicy();
    policy.rules.push(
      rule("r2-printer", "allow", { hosts: ["lab-printer"], maxRisk: "R2" }),
    );
    const decision = await evaluate(req({ risk: "R3" }), ctx({ policy }));
    expect(decision.verdict).toBe("ask");
    expect(decision.source).toBe("hard-gate");
  });
});

describe("owner rule precedence", () => {
  test("deny beats ask beats allow when all three match", async () => {
    const policy = withPolicy();
    policy.rules.push(
      rule("allow", "allow", { clients: ["agent-a"], maxRisk: "R2" }),
      rule("ask", "ask", { hosts: ["lab-printer"] }),
      rule("deny", "deny", { kinds: ["exec"], classifications: ["mutation"] }),
    );
    const denied = await evaluate(req(), ctx({ policy }));
    expect(denied).toMatchObject({
      verdict: "deny",
      source: "rule",
      ruleId: "deny",
    });

    policy.rules = policy.rules.filter((r) => r.id !== "deny");
    const asked = await evaluate(req(), ctx({ policy }));
    expect(asked).toMatchObject({
      verdict: "ask",
      source: "rule",
      ruleId: "ask",
    });

    policy.rules = policy.rules.filter((r) => r.id !== "ask");
    const allowed = await evaluate(req(), ctx({ policy }));
    expect(allowed).toMatchObject({
      verdict: "allow",
      source: "rule",
      ruleId: "allow",
    });
  });

  test("a rule whose host list does not include the request host does not apply", async () => {
    // Rules mode: the owner decides when no rule applies, so the source is "mode".
    const policy = withPolicy({}, "conservative");
    policy.rules.push(rule("other", "deny", { hosts: ["other-host"] }));
    const decision = await evaluate(req(), ctx({ policy }));
    expect(decision.verdict).toBe("ask");
    expect(decision.source).toBe("mode");
  });

  test("the built-in read-only rule allows inspection without a prompt", async () => {
    const decision = await evaluate(
      req({ argv: ["uptime"], classification: "inspect", risk: "R1" }),
      ctx(),
    );
    expect(decision).toMatchObject({
      verdict: "allow",
      ruleId: "default-inspect",
    });
  });

  test("sudo requests do not match the built-in read-only rule", async () => {
    const decision = await evaluate(
      req({
        argv: ["cat", "/etc/hosts"],
        classification: "inspect",
        risk: "R1",
        sudo: true,
      }),
      ctx(),
    );
    expect(decision.verdict).toBe("ask");
  });
});

describe("zero reviewer calls on resolved requests", () => {
  test("allow, deny, rule-ask, invariant, hard-gate and budget paths make no reviewer call", async () => {
    const stub = countingReviewer(ALLOW_ANY_REVIEW);
    const policy = autoPolicy("R2");
    policy.rules.push(
      rule("allow", "allow", { hosts: ["lab-printer"], maxRisk: "R2" }),
      rule("deny-x", "deny", { hosts: ["deny-host"] }),
      rule("ask-y", "ask", { hosts: ["ask-host"] }),
    );
    const base = { policy, reviewer: stub.reviewer };
    const results = [
      await evaluate(req(), ctx(base)),
      await evaluate(
        req({ host: "deny-host" }),
        ctx({ ...base, knownHost: true }),
      ),
      await evaluate(req({ host: "ask-host" }), ctx(base)),
      await evaluate(req({ argv: undefined }), ctx(base)),
      await evaluate(req({ risk: "R4" }), ctx(base)),
      await evaluate(req(), ctx({ ...base, clientRiskPoints: 119 })),
    ];
    for (const decision of results) expect(decision.modelCalls).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("manual and rules modes ask without calling the reviewer", async () => {
    const stub = countingReviewer(ALLOW_ANY_REVIEW);
    const policy = withPolicy({
      mode: "manual",
      reviewer: {
        authority: "delegated",
        fallback: "ask",
        maxRisk: "R2",
        provider: "x",
      },
    });
    const decision = await evaluate(
      req(),
      ctx({ policy, reviewer: stub.reviewer }),
    );
    expect(decision).toMatchObject({
      verdict: "ask",
      source: "mode",
      modelCalls: 0,
    });
    expect(stub.calls()).toBe(0);
  });
});
