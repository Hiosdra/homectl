import { describe, expect, test } from "bun:test";
import { doctor, doctorSummary } from "../src/setup";
import type { Inventory } from "../src/types";

const base = {
  checks: [
    { name: "ssh", ok: true },
    { name: "keepassxc-cli", ok: true },
  ],
  required: new Set(["ssh", "keepassxc-cli"]),
  vaultExists: true,
  onlyDefaultMachine: false,
  hostChecked: false,
};

describe("doctor summary", () => {
  test("a fresh install says it is not set up, never 'all checks passed'", () => {
    const text = doctorSummary({
      ...base,
      ok: true,
      vaultExists: false,
      onlyDefaultMachine: true,
    });
    expect(text).toBe(
      "Not set up yet. Run home-ctl setup to create your vault and add your first machine.",
    );
  });

  test("a missing KeePassXC is named plainly, with what to do", () => {
    const text = doctorSummary({
      ...base,
      ok: false,
      checks: [
        { name: "ssh", ok: true },
        { name: "keepassxc-cli", ok: false },
      ],
    });
    expect(text).toContain("KeePassXC is not installed");
    expect(text).toContain("home-ctl doctor");
  });

  test("a failed check is 'action required', not 'passed'", () => {
    const text = doctorSummary({
      ...base,
      ok: false,
      checks: [
        { name: "ssh", ok: false },
        { name: "keepassxc-cli", ok: true },
      ],
    });
    expect(text).toMatch(/^Action required/);
  });

  test("everything in place says all checks passed", () => {
    expect(doctorSummary({ ...base, ok: true })).toBe("All checks passed.");
  });

  test("a single host check on a fresh install is not called 'not set up'", () => {
    const text = doctorSummary({
      ...base,
      ok: true,
      vaultExists: false,
      onlyDefaultMachine: true,
      hostChecked: true,
    });
    expect(text).toBe("All checks passed.");
  });
});

describe("doctor always checks KeePassXC", () => {
  const inventory: Inventory = {
    version: 1,
    machines: {
      "agent-host": {
        description: "test",
        transport: "local",
        access: "user",
        enforcement: "advisory",
        caution: [],
      },
    },
  } as unknown as Inventory;

  test("an install with no KeePassXC machine still lists keepassxc-cli", async () => {
    const result = await doctor(
      inventory,
      "/nonexistent/homectl/inventory.yaml",
      undefined,
      async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    );
    expect(result.checks.map((c) => c.name)).toContain("keepassxc-cli");
    expect(typeof result.summary).toBe("string");
  });
});
