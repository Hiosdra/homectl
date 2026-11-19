import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPolicy,
  explainEffective,
  loadPolicy,
  savePolicy,
  validatePolicy,
} from "../src/authz";
import type { PolicyDocument, Rule } from "../src/core/contracts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "authz-store-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function codeOf(
  action: () => Promise<unknown>,
): Promise<number | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return (error as { code?: number }).code;
  }
}

function validationCode(value: unknown): number | undefined {
  try {
    validatePolicy(value);
    return undefined;
  } catch (error) {
    return (error as { code?: number }).code;
  }
}

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: "r1",
    effect: "allow",
    match: { hosts: ["lab-printer"], maxRisk: "R2" },
    createdAt: 0,
    createdBy: "owner",
    ...overrides,
  };
}

describe("policy store", () => {
  test("savePolicy increments the revision and loadPolicy reads it back", async () => {
    const path = join(dir, "policy-a.json");
    const first = await savePolicy(path, defaultPolicy("routine", 0));
    expect(first.revision).toBe(1);
    const second = await savePolicy(path, first);
    expect(second.revision).toBe(2);
    expect(await loadPolicy(path)).toEqual(second);
  });

  test("a stale revision is refused and the file is left as it was", async () => {
    const path = join(dir, "policy-b.json");
    const saved = await savePolicy(path, defaultPolicy("routine", 0));
    await savePolicy(path, saved);
    const before = await readFile(path, "utf8");
    expect(await codeOf(() => savePolicy(path, saved))).toBe(5);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a corrupt file is reported and never overwritten by a save", async () => {
    const path = join(dir, "policy-corrupt.json");
    await writeFile(path, "{not json", "utf8");
    expect(
      await codeOf(() => savePolicy(path, defaultPolicy("routine", 0))),
    ).toBe(5);
    expect(await readFile(path, "utf8")).toBe("{not json");
  });

  test("unknown top-level and nested fields are rejected on load", async () => {
    const path = join(dir, "policy-unknown.json");
    const good = { ...defaultPolicy("routine", 0), revision: 3 };
    await writeFile(path, JSON.stringify({ ...good, surprise: true }), "utf8");
    expect(await codeOf(() => loadPolicy(path))).toBe(2);

    const nested = {
      ...good,
      rules: [
        { ...good.rules[0], match: { ...good.rules[0]?.match, extra: 1 } },
      ],
    };
    await writeFile(path, JSON.stringify(nested), "utf8");
    expect(await codeOf(() => loadPolicy(path))).toBe(2);
  });

  test("a missing file is reported as state failure", async () => {
    expect(await codeOf(() => loadPolicy(join(dir, "absent.json")))).toBe(5);
  });

  test("no temporary files are left behind after a save", async () => {
    const path = join(dir, "policy-clean.json");
    await savePolicy(path, defaultPolicy("delegated", 0));
    const leftovers = (await readdir(dir)).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  test("the saved file is owner-readable only where the platform supports modes", async () => {
    if (process.platform === "win32") return;
    const path = join(dir, "policy-mode.json");
    await savePolicy(path, defaultPolicy("routine", 0));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("policy validation", () => {
  test("the built-in presets validate, including the read-only default rule", () => {
    for (const preset of ["conservative", "routine", "delegated"] as const) {
      expect(validationCode(defaultPolicy(preset, 0))).toBeUndefined();
    }
  });

  test("presets set mode and reviewer authority as documented", () => {
    expect(defaultPolicy("conservative")).toMatchObject({
      mode: "rules",
      reviewer: { authority: "recommend", fallback: "ask", maxRisk: "R2" },
    });
    expect(defaultPolicy("routine").mode).toBe("rules");
    expect(defaultPolicy("routine").reviewer.authority).toBe("routine");
    expect(defaultPolicy("delegated")).toMatchObject({
      mode: "auto",
      reviewer: { authority: "delegated" },
    });
  });

  test("the default budgets match the documented numbers", () => {
    expect(defaultPolicy("routine").budgets).toEqual({
      taskMaxOperations: 50,
      taskMaxRiskPoints: 60,
      clientWindowMs: 3_600_000,
      clientMaxRiskPoints: 120,
    });
  });

  test("an allow with neither client nor host is only valid when read-only up to R1", () => {
    const base = defaultPolicy("routine", 0);
    const wide = { ...base, rules: [rule({ match: { maxRisk: "R2" } })] };
    expect(validationCode(wide)).toBe(2);
    const readOnly = {
      ...base,
      rules: [rule({ match: { classifications: ["inspect"], maxRisk: "R1" } })],
    };
    expect(validationCode(readOnly)).toBeUndefined();
  });

  test("allow rules never cover R4 or human-only kinds", () => {
    const base = defaultPolicy("routine", 0);
    expect(
      validationCode({
        ...base,
        rules: [rule({ match: { hosts: ["lab-printer"], maxRisk: "R4" } })],
      }),
    ).toBe(2);
    expect(
      validationCode({
        ...base,
        rules: [
          rule({ match: { hosts: ["lab-printer"], kinds: ["host.grant"] } }),
        ],
      }),
    ).toBe(2);
  });

  test("empty lists, bad clock values, zero-length windows and duplicate ids are rejected", () => {
    const base = defaultPolicy("routine", 0);
    expect(
      validationCode({ ...base, rules: [rule({ match: { hosts: [] } })] }),
    ).toBe(2);
    expect(
      validationCode({
        ...base,
        rules: [rule({ limits: { window: { start: "24:00", end: "06:00" } } })],
      }),
    ).toBe(2);
    expect(
      validationCode({
        ...base,
        rules: [rule({ limits: { window: { start: "06:00", end: "06:00" } } })],
      }),
    ).toBe(2);
    expect(
      validationCode({
        ...base,
        rules: [rule({ id: "dup" }), rule({ id: "dup" })],
      }),
    ).toBe(2);
  });

  test("a non-integer expiry and a non-owner createdBy are rejected", () => {
    const base = defaultPolicy("routine", 0);
    expect(
      validationCode({
        ...base,
        rules: [rule({ limits: { expiresAt: 1.5 } })],
      }),
    ).toBe(2);
    expect(
      validationCode({ ...base, rules: [{ ...rule({}), createdBy: "agent" }] }),
    ).toBe(2);
  });

  test("the policy version must be 1", () => {
    expect(validationCode({ ...defaultPolicy("routine", 0), version: 2 })).toBe(
      2,
    );
  });
});

describe("explainEffective", () => {
  const policy: PolicyDocument = {
    ...defaultPolicy("routine", 0),
    revision: 9,
    rules: [
      ...defaultPolicy("routine", 0).rules,
      rule({
        id: "printer-r2",
        match: { hosts: ["lab-printer"], maxRisk: "R2" },
      }),
      rule({
        id: "elsewhere",
        effect: "deny",
        match: { hosts: ["other-host"] },
      }),
      rule({
        id: "lapsed",
        effect: "allow",
        match: { hosts: ["lab-printer"] },
        limits: { expiresAt: NOW - 1 },
      }),
      rule({
        id: "night",
        effect: "allow",
        match: { hosts: ["lab-printer"] },
        limits: { window: { start: "00:00", end: "01:00" } },
      }),
    ],
  };

  test("reports which rules apply to a client and host, and why the others do not", () => {
    const view = explainEffective(policy, "agent-a", "lab-printer", NOW);
    expect(view.revision).toBe(9);
    const byId = new Map(view.rules.map((r) => [r.ruleId, r]));
    expect(byId.get("default-inspect")?.applies).toBe(true);
    expect(byId.get("printer-r2")?.applies).toBe(true);
    expect(byId.get("printer-r2")?.reasons).toContain("covers risk up to R2");
    expect(byId.get("elsewhere")?.applies).toBe(false);
    expect(byId.get("elsewhere")?.reasons).toContain("does not list this host");
    expect(byId.get("lapsed")?.applies).toBe(false);
    expect(byId.get("lapsed")?.reasons).toContain("has expired");
  });

  test("a host-scoped rule needs a host to match", () => {
    const view = explainEffective(policy, "agent-a", undefined, NOW);
    const byId = new Map(view.rules.map((r) => [r.ruleId, r]));
    expect(byId.get("printer-r2")?.applies).toBe(false);
    expect(byId.get("printer-r2")?.reasons).toContain("needs a host to match");
  });
});
