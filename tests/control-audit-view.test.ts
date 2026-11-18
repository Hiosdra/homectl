import { expect, test } from "bun:test";
import {
  auditHistory,
  auditHistoryFromRows,
  auditHistoryRows,
  commandHistoryRows,
} from "../src/control/audit-view";
import { AUDIT_NORMALIZATION_MARKERS } from "../src/control/redact";
import type { AuditEntry, AuditEvent } from "../src/control/types";
import type { CommandHistoryEntry } from "../src/command-history";
import {
  canSaveAuditRow,
  savedCommandDraftFromAuditRow,
} from "../src/web/screens/audit";

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
    }),
    entry(3, {
      event: "request.rejected",
      operationId: "stored-refusal",
      reason: "policy refused by legacy validation",
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

test("merged history pagination keeps cursors stable across both sources", () => {
  const at = new Date(Date.UTC(2026, 10, 17, 0, 0, 5)).toISOString();
  const controlEntries = [
    {
      ...entry(1, {
        event: "operation.planned",
        operationId: "control-operation",
        host: "example",
        argv: ["hostname"],
      }),
      at,
    },
  ];
  const commandEntries: CommandHistoryEntry[] = [
    {
      id: "history-start",
      sequence: 1,
      at,
      phase: "started",
      host: "example",
      argv: ["hostname"],
      requester: "local-operator",
      operationId: "command-operation",
      policyDecision: "allowed",
      status: "executing",
    },
  ];
  const firstPage = auditHistoryFromRows(
    [...auditHistoryRows(controlEntries, {}), ...commandHistoryRows(commandEntries)],
    { limit: 1 },
  );
  expect(firstPage.entries[0]?.source).toBe("command-history");

  commandEntries.push({
    id: "history-outcome",
    sequence: 2,
    at: new Date(Date.parse(at) + 1000).toISOString(),
    phase: "outcome",
    host: "example",
    argv: ["hostname"],
    requester: "local-operator",
    operationId: "command-operation",
    policyDecision: "allowed",
    status: "succeeded",
  });
  const nextPage = auditHistoryFromRows(
    [...auditHistoryRows(controlEntries, {}), ...commandHistoryRows(commandEntries)],
    { limit: 1, cursor: firstPage.nextCursor },
  );
  expect(nextPage.entries.map((row) => row.source)).toEqual(["control-plane"]);
});

test("audit save button excludes redaction markers anywhere in argv", () => {
  const markers = [
    AUDIT_NORMALIZATION_MARKERS.emptyArgument,
    AUDIT_NORMALIZATION_MARKERS.truncatedArgument,
    `${AUDIT_NORMALIZATION_MARKERS.truncatedArgumentsPrefix}2${AUDIT_NORMALIZATION_MARKERS.truncatedArgumentsSuffix}`,
    AUDIT_NORMALIZATION_MARKERS.noArguments,
    AUDIT_NORMALIZATION_MARKERS.redacted,
  ];
  for (const marker of markers)
    expect(canSaveAuditRow({ host: "example", argv: ["tool", marker] })).toBe(
      false,
    );
  expect(canSaveAuditRow({ host: "example", argv: ["hostname"] })).toBe(true);
  const historyRow = commandHistoryRows([
    {
      id: "history-save",
      sequence: 1,
      at: new Date(0).toISOString(),
      phase: "outcome",
      host: "example",
      argv: ["hostname"],
      requester: "local-operator",
      operationId: "save-command",
      policyDecision: "allowed",
      status: "succeeded",
    },
  ])[0]?.row;
  expect(historyRow?.source).toBe("command-history");
  expect(savedCommandDraftFromAuditRow(historyRow)).toMatchObject({
    hosts: ["example"],
    argv: ["hostname"],
  });
});
