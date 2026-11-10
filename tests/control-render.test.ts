import { expect, test } from "bun:test";
import { renderOperationDetail } from "../src/control/present";
import type { OperationView } from "../src/control/types";

const NOW = Date.UTC(2026, 10, 5, 23, 40);
function view(overrides: Partial<OperationView>): OperationView {
  return {
    operationId: "0b6f2c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b",
    state: "succeeded",
    host: "agent-host",
    classification: "inspect",
    needsApproval: false,
    fingerprint: "a".repeat(64),
    argv: ["whoami"],
    impact: "Read the account name",
    issuer: "codex-pc",
    createdAt: new Date(NOW - 600_000).toISOString(),
    expiresAt: new Date(NOW - 300_000).toISOString(),
    updatedAt: new Date(NOW - 120_000).toISOString(),
    expired: false,
    spawnAttempted: true,
    exitCode: 0,
    ...overrides,
  };
}

test("a legacy succeeded record with no start time reads as finished, not never executed", () => {
  const text = renderOperationDetail(view({}), { color: false, now: NOW });
  expect(text).toMatch(/^Finished\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
  expect(text).not.toContain("never executed");
  expect(text).not.toMatch(/^Duration/m);
});

test("never-spawned closures say never executed", () => {
  const text = renderOperationDetail(
    view({
      state: "failed",
      reason: "plan-expired",
      spawnAttempted: false,
      exitCode: undefined,
    }),
    { color: false, now: NOW },
  );
  expect(text).toContain("never executed");
  expect(text).not.toMatch(/^Finished/m);
});
