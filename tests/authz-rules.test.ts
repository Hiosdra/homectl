import { describe, expect, test } from "bun:test";
import { exactMatch, ruleFromDecision, suggestRule } from "../src/authz";
import { limitsAllow, matchesScope, ruleApplies } from "../src/authz/match";
import type { ActionRequest, Rule } from "../src/core/contracts";

const NOW = Date.parse("2026-11-19T12:00:00Z");

function req(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    client: "agent-a",
    kind: "exec",
    host: "lab-printer",
    argv: ["systemctl", "status", "klipper"],
    classification: "inspect",
    risk: "R1",
    ...overrides,
  };
}

function rule(
  match: Rule["match"],
  limits?: Rule["limits"],
  extra: Partial<Rule> = {},
): Rule {
  return {
    id: "r",
    effect: "allow",
    match,
    createdAt: 0,
    createdBy: "owner",
    ...(limits ? { limits } : {}),
    ...extra,
  };
}

// Local wall-clock helper so window tests do not depend on the machine zone.
function localAt(hours: number, minutes: number): number {
  return new Date(2026, 10, 19, hours, minutes, 0, 0).getTime();
}

describe("scope matching", () => {
  test("argv prefixes match whole leading tokens only", () => {
    const match = { argvPrefixes: [["systemctl", "status"]] };
    expect(
      matchesScope(match, req({ argv: ["systemctl", "status", "klipper"] })),
    ).toBe(true);
    expect(
      matchesScope(match, req({ argv: ["systemctl", "restart", "klipper"] })),
    ).toBe(false);
    expect(matchesScope(match, req({ argv: ["systemctl"] }))).toBe(false);
    expect(matchesScope(match, req({ argv: undefined }))).toBe(false);
  });

  test("an empty argvPrefixes list is no argv constraint", () => {
    expect(matchesScope({ argvPrefixes: [] }, req({ argv: ["whoami"] }))).toBe(
      true,
    );
  });

  test("a host constraint never matches a request without a host", () => {
    expect(
      matchesScope({ hosts: ["lab-printer"] }, req({ host: undefined })),
    ).toBe(false);
  });

  test("an empty clients or hosts list fails closed", () => {
    expect(matchesScope({ clients: [] }, req())).toBe(false);
    expect(matchesScope({ hosts: [] }, req())).toBe(false);
  });

  test("sudo must match exactly, and an unset sudo flag counts as false", () => {
    expect(matchesScope({ sudo: false }, req())).toBe(true);
    expect(matchesScope({ sudo: false }, req({ sudo: true }))).toBe(false);
    expect(matchesScope({ sudo: true }, req())).toBe(false);
  });
});

describe("limits", () => {
  test("expiry stops a rule at its expiresAt instant", () => {
    const limits = { expiresAt: NOW + 60_000 };
    expect(limitsAllow(limits, undefined, NOW + 59_999)).toBe(true);
    expect(limitsAllow(limits, undefined, NOW + 60_000)).toBe(false);
  });

  test("maxUses stops after the last permitted use", () => {
    const limits = { maxUses: 2 };
    expect(limitsAllow(limits, 0, NOW)).toBe(true);
    expect(limitsAllow(limits, 1, NOW)).toBe(true);
    expect(limitsAllow(limits, 2, NOW)).toBe(false);
  });

  test("a window that does not cross midnight applies between its bounds", () => {
    const limits = { window: { start: "09:00", end: "17:00" } };
    expect(limitsAllow(limits, undefined, localAt(9, 0))).toBe(true);
    expect(limitsAllow(limits, undefined, localAt(16, 59))).toBe(true);
    expect(limitsAllow(limits, undefined, localAt(17, 0))).toBe(false);
    expect(limitsAllow(limits, undefined, localAt(8, 59))).toBe(false);
  });

  test("a window that crosses midnight covers both sides of 00:00", () => {
    const limits = { window: { start: "22:00", end: "06:00" } };
    expect(limitsAllow(limits, undefined, localAt(23, 30))).toBe(true);
    expect(limitsAllow(limits, undefined, localAt(1, 0))).toBe(true);
    expect(limitsAllow(limits, undefined, localAt(5, 59))).toBe(true);
    expect(limitsAllow(limits, undefined, localAt(6, 0))).toBe(false);
    expect(limitsAllow(limits, undefined, localAt(12, 0))).toBe(false);
  });

  test("an expired or exhausted rule does not apply at all", () => {
    const expired = rule({ hosts: ["lab-printer"] }, { expiresAt: NOW - 1 });
    expect(ruleApplies(expired, req(), NOW)).toBe(false);
    const spent = rule({ hosts: ["lab-printer"] }, { maxUses: 1 }, { uses: 1 });
    expect(ruleApplies(spent, req(), NOW)).toBe(false);
  });

  test("an allow rule without maxRisk stops at R2; R3 needs maxRisk R3", () => {
    const open = rule({ hosts: ["lab-printer"] });
    expect(ruleApplies(open, req({ risk: "R2" }), NOW)).toBe(true);
    expect(ruleApplies(open, req({ risk: "R3" }), NOW)).toBe(false);
    const r3 = rule({ hosts: ["lab-printer"], maxRisk: "R3" });
    expect(ruleApplies(r3, req({ risk: "R3" }), NOW)).toBe(true);
  });

  test("a deny rule with maxRisk R1 only applies up to R1", () => {
    const deny = rule({ hosts: ["lab-printer"], maxRisk: "R1" }, undefined, {
      effect: "deny",
    });
    expect(ruleApplies(deny, req({ risk: "R1" }), NOW)).toBe(true);
    expect(ruleApplies(deny, req({ risk: "R2" }), NOW)).toBe(false);
  });
});

describe("ruleFromDecision", () => {
  test("builds an exact allow rule: client, host, kind, full argv, maxRisk and sudo", () => {
    const built = ruleFromDecision(
      req({ risk: "R2", classification: "mutation" }),
      "allow",
      NOW,
      "rule-1",
    );
    expect(built).toEqual({
      id: "rule-1",
      effect: "allow",
      match: {
        clients: ["agent-a"],
        hosts: ["lab-printer"],
        kinds: ["exec"],
        argvPrefixes: [["systemctl", "status", "klipper"]],
        maxRisk: "R2",
        sudo: false,
      },
      createdAt: NOW,
      createdBy: "owner",
    });
  });

  test("never produces a wildcard: the argv is copied, not shared", () => {
    const argv = ["uptime"];
    const built = ruleFromDecision(
      req({ argv, classification: "inspect" }),
      "allow",
      NOW,
      "r-2",
    );
    argv.push("--evil");
    expect(built.match.argvPrefixes).toEqual([["uptime"]]);
  });

  test("throws for an allow on a human-only kind or on R4", () => {
    expect(() =>
      ruleFromDecision(
        req({ kind: "host.grant", argv: undefined }),
        "allow",
        NOW,
        "r-3",
      ),
    ).toThrow();
    expect(() =>
      ruleFromDecision(req({ risk: "R4" }), "allow", NOW, "r-4"),
    ).toThrow();
  });

  test("refuses an allow without an exact host or without argv for exec", () => {
    expect(() =>
      ruleFromDecision(req({ host: undefined }), "allow", NOW, "r-5"),
    ).toThrow();
    expect(() =>
      ruleFromDecision(req({ argv: undefined }), "allow", NOW, "r-6"),
    ).toThrow();
  });

  test("a deny may be remembered for a human-only kind", () => {
    const denied = ruleFromDecision(
      req({ kind: "secret.raw", argv: undefined }),
      "deny",
      NOW,
      "r-7",
    );
    expect(denied.effect).toBe("deny");
    expect(denied.match.kinds).toEqual(["secret.raw"]);
  });

  test("rejects a malformed rule id", () => {
    expect(() => ruleFromDecision(req(), "allow", NOW, "bad id!")).toThrow();
  });
});

describe("suggestRule", () => {
  test("is the same narrow shape as a remembered allow and installs nothing", () => {
    const suggestion = suggestRule(req({ classification: "inspect" }));
    expect(suggestion.effect).toBe("allow");
    expect(suggestion.match).toEqual(
      exactMatch(req({ classification: "inspect" })),
    );
    expect(suggestion.match.clients).toEqual(["agent-a"]);
    expect(suggestion.match.hosts).toEqual(["lab-printer"]);
  });

  test("refuses human-only kinds and R4 just as ruleFromDecision does", () => {
    expect(() => suggestRule(req({ risk: "R4" }))).toThrow();
    expect(() =>
      suggestRule(req({ kind: "policy.change", argv: undefined })),
    ).toThrow();
  });

  test("a resource narrows the exact match further", () => {
    const match = exactMatch(
      req({ kind: "proxmox", argv: undefined, resource: "vm:105" }),
    );
    expect(match.resources).toEqual(["vm:105"]);
  });
});
