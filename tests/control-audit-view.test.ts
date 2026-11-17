import { expect, test } from "bun:test";
import { auditHistory } from "../src/control/audit-view";
import type { AuditEntry, AuditEvent } from "../src/control/types";
import { canSaveAuditRow } from "../src/web/screens/audit";

function entry(seq: number, event: AuditEvent): AuditEntry {
  return {
    v: 1,
    seq,
    at: new Date(Date.UTC(2026, 10, 17, 0, 0, seq)).toISOString(),
    prev: "0".repeat(64),
    hash: "1".repeat(64),
    event,
  };
}

test("audit pagination remains stable when an older operation receives a new event", () => {
  const entries = [
    entry(1, {
      event: "operation.planned",
      operationId: "first-operation",
      host: "example",
      argv: ["hostname"],
    }),
    entry(2, {
      event: "operation.planned",
      operationId: "second-operation",
      host: "example",
      argv: ["hostname"],
    }),
  ];
  const firstPage = auditHistory(entries, {}, { limit: 1 });
  expect(firstPage.entries[0]?.operationId).toBe("second-operation");

  entries.push(
    entry(3, {
      event: "operation.succeeded",
      operationId: "first-operation",
      exitCode: 0,
    }),
  );
  const nextPage = auditHistory(
    entries,
    {},
    {
      limit: 1,
      cursor: firstPage.nextCursor,
    },
  );
  expect(nextPage.entries[0]?.operationId).toBe("first-operation");
});

test("audit history reports explicit refusals and only infers legacy rejections", () => {
  const history = auditHistory([
    entry(1, {
      event: "operation.planned",
      operationId: "rejected-operation",
      host: "example",
      argv: ["systemctl", "restart", "service"],
    }),
    entry(2, {
      event: "operation.decided",
      operationId: "rejected-operation",
      decision: "reject",
      policyDecision: "refused",
    }),
    entry(3, {
      event: "request.rejected",
      operationId: "stored-refusal",
      reason: "approval required by legacy policy text",
      policyDecision: "refused",
    }),
    entry(4, {
      event: "request.rejected",
      operationId: "legacy-approval-required",
      reason: "approval required",
    }),
  ]);
  expect(
    history.entries.find((row) => row.operationId === "rejected-operation"),
  ).toMatchObject({ status: "refused", policyDecision: "refused" });
  expect(
    history.entries.find((row) => row.operationId === "stored-refusal"),
  ).toMatchObject({ status: "refused", policyDecision: "refused" });
  expect(
    history.entries.find(
      (row) => row.operationId === "legacy-approval-required",
    ),
  ).toMatchObject({
    status: "approval-required",
    policyDecision: "needs-approval",
  });
});

test("audit save button excludes redaction markers anywhere in argv", () => {
  expect(
    canSaveAuditRow({ host: "example", argv: ["tool", "NAME=[REDACTED]"] }),
  ).toBe(false);
  expect(canSaveAuditRow({ host: "example", argv: ["hostname"] })).toBe(true);
});
