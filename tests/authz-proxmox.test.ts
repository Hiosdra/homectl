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

// Proxmox requests against the decision pipeline. Owner-only and R4 requests
// stop at the hard gate: no rule and no AI helper can approve them.

const NOW = Date.parse("2026-11-21T12:00:00Z");

function req(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    client: "codex-pc",
    kind: "proxmox",
    host: "pve-host",
    argv: ["proxmox-api", "GET", "/access/users"],
    sudo: false,
    classification: "destructive",
    risk: "R4",
    ...overrides,
  };
}

function autoPolicy(): PolicyDocument {
  const base = defaultPolicy("delegated", 0);
  return {
    ...base,
    mode: "auto",
    reviewer: { ...base.reviewer, provider: "test-model", maxRisk: "R2" },
  };
}

// A reviewer that would allow anything. The test checks it is never asked.
function spyReviewer(): { reviewer: Reviewer; calls: ReviewerInput[] } {
  const calls: ReviewerInput[] = [];
  return {
    calls,
    reviewer: {
      id: "spy",
      review: async (input) => {
        calls.push(input);
        return { verdict: "allow", reason: "looks fine" };
      },
    },
  };
}

function ctx(overrides: Partial<EvaluateContext> = {}): EvaluateContext {
  return {
    policy: autoPolicy(),
    clientRiskPoints: 0,
    knownHost: true,
    now: NOW,
    ...overrides,
  };
}

describe("owner-only Proxmox requests", () => {
  test("R4 goes to the owner with step-up and never reaches the reviewer", async () => {
    const spy = spyReviewer();
    const decision = await evaluate(req(), ctx({ reviewer: spy.reviewer }));
    expect(decision.verdict).toBe("ask");
    expect(decision.source).toBe("hard-gate");
    expect(decision.humanOnly).toBe(true);
    expect(decision.stepUp).toBe(true);
    expect(decision.modelCalls).toBe(0);
    expect(spy.calls).toHaveLength(0);
  });

  test("an owner allow rule cannot approve an R4 Proxmox request", async () => {
    const allow: Rule = {
      id: "rule-allow-proxmox",
      effect: "allow",
      match: { kinds: ["proxmox"] },
      createdAt: 0,
      createdBy: "owner",
    };
    const policy: PolicyDocument = {
      ...defaultPolicy("routine", 0),
      rules: [allow],
    };
    const decision = await evaluate(req(), ctx({ policy }));
    expect(decision.verdict).toBe("ask");
    expect(decision.humanOnly).toBe(true);
    expect(decision.source).toBe("hard-gate");
  });

  test("a safe Proxmox read (R1) runs under the built-in read rule", async () => {
    const decision = await evaluate(
      req({
        argv: ["proxmox-api", "GET", "/version"],
        classification: "inspect",
        risk: "R1",
      }),
      ctx({ policy: defaultPolicy("routine", 0) }),
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.ruleId).toBe("default-inspect");
  });
});
