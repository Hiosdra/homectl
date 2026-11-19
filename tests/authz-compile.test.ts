import { describe, expect, test } from "bun:test";
import { compileRule } from "../src/authz";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const known = {
  hosts: ["lab-printer", "lab"],
  clients: ["agent-a", "ops"],
};

describe("compileRule", () => {
  test("host, client, verb and duration become structured limits; the rest is residual", () => {
    const result = compileRule(
      "allow restarts of klipper on lab-printer for agent-a for 2 hours",
      known,
      NOW,
    );
    expect(result.effect).toBe("allow");
    expect(result.match).toEqual({
      clients: ["agent-a"],
      hosts: ["lab-printer"],
      maxRisk: "R2",
    });
    expect(result.limits).toEqual({ expiresAt: NOW + 2 * 3_600_000 });
    expect(result.residual).toBe("restarts klipper");
    expect(result.needsConfirmation).toBe(false);
  });

  test("never with a host is a deny with no maxRisk", () => {
    const result = compileRule("never touch lab-printer", known, NOW);
    expect(result.effect).toBe("deny");
    expect(result.match).toEqual({ hosts: ["lab-printer"] });
    expect(result.needsConfirmation).toBe(false);
  });

  test("backtick commands become exact argv prefixes with kind exec", () => {
    const result = compileRule(
      "allow `systemctl status` on lab-printer",
      known,
      NOW,
    );
    expect(result.match.argvPrefixes).toEqual([["systemctl", "status"]]);
    expect(result.match.kinds).toEqual(["exec"]);
    expect(result.match.hosts).toEqual(["lab-printer"]);
  });

  test("read-only maps to the inspect classification", () => {
    const result = compileRule("allow read-only on lab-printer", known, NOW);
    expect(result.match.classifications).toEqual(["inspect"]);
    expect(result.match.hosts).toEqual(["lab-printer"]);
  });

  test("a longer known host is consumed first, so lab is not also matched inside lab-printer", () => {
    const result = compileRule("allow read-only on lab-printer", known, NOW);
    expect(result.match.hosts).toEqual(["lab-printer"]);
    const shorter = compileRule("ask on lab", known, NOW);
    expect(shorter.match.hosts).toEqual(["lab"]);
  });

  test("matching is case-insensitive and returns the canonical name", () => {
    const result = compileRule("ALLOW LAB-PRINTER", known, NOW);
    expect(result.match.hosts).toEqual(["lab-printer"]);
    expect(result.effect).toBe("allow");
  });

  test("between HH:MM and HH:MM becomes a daily window, including across midnight", () => {
    const window = compileRule(
      "allow between 22:00 and 6:00 on lab-printer",
      known,
      NOW,
    );
    expect(window.limits?.window).toEqual({ start: "22:00", end: "06:00" });
    const day = compileRule(
      "ask agent-a between 9:00 and 17:00 on lab",
      known,
      NOW,
    );
    expect(day.limits?.window).toEqual({ start: "09:00", end: "17:00" });
  });

  test("an invalid window is not applied and needs confirmation", () => {
    const result = compileRule(
      "allow between 25:00 and 06:00 on lab-printer",
      known,
      NOW,
    );
    expect(result.limits?.window).toBeUndefined();
    expect(result.needsConfirmation).toBe(true);
    const same = compileRule(
      "allow between 06:00 and 06:00 on lab-printer",
      known,
      NOW,
    );
    expect(same.limits?.window).toBeUndefined();
    expect(same.needsConfirmation).toBe(true);
  });

  test("days and minutes are understood; zero or huge durations need confirmation", () => {
    const days = compileRule("allow lab-printer for 3 days", known, NOW);
    expect(days.limits?.expiresAt).toBe(NOW + 3 * 24 * 3_600_000);
    const minutes = compileRule("allow lab-printer for 15 minutes", known, NOW);
    expect(minutes.limits?.expiresAt).toBe(NOW + 15 * 60_000);
    const zero = compileRule("allow lab-printer for 0 hours", known, NOW);
    expect(zero.limits).toBeUndefined();
    expect(zero.needsConfirmation).toBe(true);
    const huge = compileRule("allow lab-printer for 9999 days", known, NOW);
    expect(huge.limits).toBeUndefined();
    expect(huge.needsConfirmation).toBe(true);
  });

  test("an allow with neither host nor client is never produced: it becomes an ask that needs confirmation", () => {
    const result = compileRule("allow everything", known, NOW);
    expect(result.effect).toBe("ask");
    expect(result.match.hosts).toBeUndefined();
    expect(result.match.clients).toBeUndefined();
    expect(result.needsConfirmation).toBe(true);
    expect(result.explanation.join(" ")).toContain("confirm");
  });

  test("an unscoped allow with only commands is also downgraded", () => {
    const result = compileRule("allow `reboot`", known, NOW);
    expect(result.effect).toBe("ask");
    expect(result.needsConfirmation).toBe(true);
  });

  test("conflicting verbs use the most restrictive one", () => {
    const result = compileRule(
      "never allow agent-a on lab-printer",
      known,
      NOW,
    );
    expect(result.effect).toBe("deny");
    expect(result.explanation.join(" ")).toContain("Several verbs");
  });

  test("with no verb recognised the draft is an ask", () => {
    const result = compileRule("agent-a on lab-printer", known, NOW);
    expect(result.effect).toBe("ask");
    expect(result.explanation.join(" ")).toContain("No verb");
  });

  test("residual words never change the match", () => {
    const result = compileRule(
      "allow lab-printer, maybe only restarts on weekends",
      known,
      NOW,
    );
    expect(result.residual).toContain("weekends");
    expect(result.match).toEqual({ hosts: ["lab-printer"], maxRisk: "R2" });
  });

  test("empty or over-long text is refused", () => {
    expect(() => compileRule("   ", known, NOW)).toThrow();
    expect(() => compileRule("allow ".repeat(120), known, NOW)).toThrow();
  });
});
