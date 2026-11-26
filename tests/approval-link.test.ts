import { describe, expect, test } from "bun:test";
import { approvalLink, toView } from "../src/broker/plan";
import type { BrokerOperation } from "../src/broker/types";

function op(overrides: Partial<BrokerOperation> = {}): BrokerOperation {
  return {
    id: "op-7f3a",
    state: "awaiting-approval",
    host: "lab-printer",
    argv: ["systemctl", "restart", "klipper"],
    classification: "mutation",
    risk: "R2",
    fingerprint: "sha256:abc",
    decision: { verdict: "ask", source: "mode", reason: "owner decides" },
    createdAt: Date.parse("2026-11-20T12:00:00Z"),
    expiresAt: Date.parse("2026-11-20T12:10:00Z"),
    client: "agent-a",
    ...overrides,
  } as unknown as BrokerOperation;
}

describe("approval link", () => {
  test("points at the request itself, under the approvals route", () => {
    expect(approvalLink("http://127.0.0.1:7451/#/approvals", "op-7f3a")).toBe(
      "http://127.0.0.1:7451/#/approvals/op-7f3a",
    );
  });

  test("tolerates a trailing slash on the base and encodes the id", () => {
    expect(approvalLink("http://127.0.0.1:7451/#/approvals/", "op/1")).toBe(
      "http://127.0.0.1:7451/#/approvals/op%2F1",
    );
  });

  test("the operation view carries the per-request link while it waits", () => {
    const view = toView(op(), "http://127.0.0.1:7451/#/approvals");
    expect(view.approvalSurface).toBe(
      "http://127.0.0.1:7451/#/approvals/op-7f3a",
    );
  });

  test("the link never appears for an operation that is not waiting", () => {
    const view = toView(
      op({ state: "done" as BrokerOperation["state"] }),
      "http://127.0.0.1:7451/#/approvals",
    );
    expect(view.approvalSurface).toBeUndefined();
  });

  test("no panel origin means no link", () => {
    expect(toView(op()).approvalSurface).toBeUndefined();
  });
});
