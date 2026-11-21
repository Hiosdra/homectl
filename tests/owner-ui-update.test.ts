// Owner panel: the update status the panel reads (homelab #21 §8). The broker's
// reason for a blocked install is shown; it is kept only when the install is
// blocked, and bounded so a bad broker cannot flood the page.
import { expect, test } from "bun:test";
import { toUpdateStatus } from "../src/web/owner/update-api";

const base = {
  current: "0.3.0",
  latest: "0.3.1",
  available: true,
  signature: "verified",
};

test("a blocked install keeps the broker's reason", () => {
  const status = toUpdateStatus({
    ...base,
    canApply: false,
    reason:
      "This broker runs in a container. Update it by redeploying its image.",
  });
  expect(status?.canApply).toBe(false);
  expect(status?.reason).toBe(
    "This broker runs in a container. Update it by redeploying its image.",
  );
});

test("an install the panel can apply carries no reason", () => {
  const status = toUpdateStatus({
    ...base,
    canApply: true,
    reason: "stale text from an older broker",
  });
  expect(status?.canApply).toBe(true);
  expect(status?.reason).toBeUndefined();
});

test("an over-long or non-text reason is dropped, not shown", () => {
  expect(
    toUpdateStatus({ ...base, canApply: false, reason: "x".repeat(401) })
      ?.reason,
  ).toBeUndefined();
  expect(
    toUpdateStatus({ ...base, canApply: false, reason: 42 })?.reason,
  ).toBeUndefined();
});
