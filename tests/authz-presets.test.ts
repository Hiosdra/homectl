import { describe, expect, test } from "bun:test";
import {
  defaultPolicy,
  type EvaluateContext,
  evaluate,
  type Reviewer,
  type ReviewerInput,
} from "../src/authz";
import type { ActionRequest, PolicyDocument } from "../src/core/contracts";

const NOW = Date.parse("2026-11-20T12:00:00Z");

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

// A preset with an AI helper configured, as the panel leaves it once set up.
function withHelper(
  preset: "conservative" | "routine" | "delegated",
  maxRisk: PolicyDocument["reviewer"]["maxRisk"] = "R2",
): PolicyDocument {
  const base = defaultPolicy(preset, 0);
  return {
    ...base,
    revision: 3,
    reviewer: { ...base.reviewer, provider: "test-model", maxRisk },
  };
}

function countingReviewer(verdict: "allow" | "deny" = "allow"): {
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
        return { verdict, reason: "stub" };
      },
    },
    calls: () => count,
    inputs,
  };
}

function ctx(policy: PolicyDocument, reviewer?: Reviewer): EvaluateContext {
  return {
    policy,
    clientRiskPoints: 0,
    knownHost: true,
    now: NOW,
    ...(reviewer ? { reviewer } : {}),
  };
}

describe("AI helper presets", () => {
  test("Ask me first is rules mode with recommend authority", () => {
    const policy = defaultPolicy("conservative", 0);
    expect(policy.mode).toBe("rules");
    expect(policy.reviewer.authority).toBe("recommend");
  });

  test("AI helps with small fixes is auto mode with routine authority", () => {
    const policy = defaultPolicy("routine", 0);
    expect(policy.mode).toBe("auto");
    expect(policy.reviewer.authority).toBe("routine");
  });

  test("AI decides more is auto mode with delegated authority", () => {
    const policy = defaultPolicy("delegated", 0);
    expect(policy.mode).toBe("auto");
    expect(policy.reviewer.authority).toBe("delegated");
  });

  test("AI helps with small fixes consults the helper for an uncovered R2 change", async () => {
    const stub = countingReviewer("allow");
    const decision = await evaluate(
      req({ classification: "mutation", risk: "R2" }),
      ctx(withHelper("routine"), stub.reviewer),
    );
    expect(stub.calls()).toBe(1);
    expect(decision).toMatchObject({
      verdict: "allow",
      source: "reviewer",
      modelCalls: 1,
    });
  });

  test("Ask me first never calls the helper", async () => {
    const stub = countingReviewer("allow");
    const decision = await evaluate(
      req(),
      ctx(withHelper("conservative"), stub.reviewer),
    );
    expect(stub.calls()).toBe(0);
    expect(decision).toMatchObject({ verdict: "ask", source: "mode" });
  });

  test("routine authority still refuses an R3 change, even when the helper says allow", async () => {
    const stub = countingReviewer("allow");
    const decision = await evaluate(
      req({ risk: "R3", classification: "mutation" }),
      ctx(withHelper("routine", "R3"), stub.reviewer),
    );
    expect(decision.verdict).not.toBe("allow");
    expect(decision.verdict).not.toBe("deny");
  });

  test("delegated authority still refuses an R3 change, even when the helper says allow", async () => {
    const stub = countingReviewer("allow");
    const decision = await evaluate(
      req({ risk: "R3", classification: "mutation" }),
      ctx(withHelper("delegated", "R3"), stub.reviewer),
    );
    expect(decision.verdict).not.toBe("allow");
  });

  test("an R4 change never reaches the helper under any AI preset", async () => {
    for (const preset of ["routine", "delegated"] as const) {
      const stub = countingReviewer("allow");
      const decision = await evaluate(
        req({ risk: "R4", classification: "mutation" }),
        ctx(withHelper(preset, "R4"), stub.reviewer),
      );
      expect(stub.calls()).toBe(0);
      expect(decision.verdict).not.toBe("allow");
    }
  });

  test("a helper deny still stands under routine authority", async () => {
    const stub = countingReviewer("deny");
    const decision = await evaluate(
      req(),
      ctx(withHelper("routine"), stub.reviewer),
    );
    expect(decision.verdict).toBe("deny");
  });
});
