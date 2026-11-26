// Owner panel: what a queued decision says and what the buttons do while it is
// on its way, and which operations are still under the Auto Mode reviewer. The
// server enforces the same rules; these functions only decide what the panel
// shows.
import { expect, test } from "bun:test";
import {
  approveRememberOffered,
  isUnderReview,
  UNDER_REVIEW_NOTE,
} from "../src/web/owner/review";
import { intentState } from "../src/web/owner/workspace-api";

test("a queued approval says so and blocks both buttons", () => {
  const state = intentState({
    decision: "approve-once",
    status: "queued",
    expiresAt: 0,
  });
  expect(state?.text).toContain("Approval queued for the client");
  expect(state?.blocks).toBe(true);
  expect(state?.applied).toBe(false);
  expect(state?.refused).toBe(false);
});

test("a delivered denial is still waiting and blocks the buttons", () => {
  const state = intentState({
    decision: "deny-once",
    status: "delivered",
    expiresAt: 0,
  });
  expect(state?.text).toContain("Denial delivered to the client");
  expect(state?.blocks).toBe(true);
});

test("an applied decision ends the item without blocking it", () => {
  const state = intentState({
    decision: "approve-once",
    status: "applied",
    expiresAt: 0,
  });
  expect(state?.applied).toBe(true);
  expect(state?.blocks).toBe(false);
  expect(state?.tone).toBe("good");
});

test("a refused decision shows the client's reason and does not block", () => {
  const state = intentState({
    decision: "approve-once",
    status: "refused",
    reason: "The plan changed",
    expiresAt: 0,
  });
  expect(state?.text).toBe("Approval refused by the client: The plan changed");
  expect(state?.refused).toBe(true);
  expect(state?.blocks).toBe(false);
  expect(state?.tone).toBe("bad");
});

test("a refused decision without a reason says so plainly", () => {
  const state = intentState({
    decision: "deny-once",
    status: "refused",
    expiresAt: 0,
  });
  expect(state?.text).toBe("Denial refused by the client.");
});

test("no intent means no status line and no lock", () => {
  expect(intentState(null)).toBeUndefined();
  expect(intentState(undefined)).toBeUndefined();
});

test("only the review source counts as under review", () => {
  expect(isUnderReview("review")).toBe(true);
  expect(isUnderReview("rule")).toBe(false);
  expect(isUnderReview("default")).toBe(false);
  expect(isUnderReview(undefined)).toBe(false);
  expect(UNDER_REVIEW_NOTE).toContain("Under review");
});

test("approve and remember is offered for a rule-decided operation", () => {
  expect(approveRememberOffered({ source: "rule", humanOnly: false })).toBe(
    true,
  );
  expect(approveRememberOffered({ source: "mode" })).toBe(true);
});

test("approve and remember is not offered while under review", () => {
  expect(approveRememberOffered({ source: "review", humanOnly: false })).toBe(
    false,
  );
});

test("approve and remember is not offered for a human-only operation", () => {
  expect(approveRememberOffered({ source: "hard-gate", humanOnly: true })).toBe(
    false,
  );
});
