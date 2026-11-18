import type { CommandHistoryEntry } from "../command-history";
import { redactCommandHistoryArgv } from "../command-history";
import { HomectlError } from "../types";
import { redactArgv } from "./redact";
import type { AuditEntry, AuditEvent, Classification } from "./types";

export type AuditPolicyDecision = "allowed" | "needs-approval" | "refused";
export type AuditStatus =
  | "pending"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "refused"
  | "approval-required";

export type AuditHistoryRow = {
  id: string;
  sequence: number;
  at: string;
  source: "control-plane" | "command-history";
  operationId?: string;
  operation?: string;
  host?: string;
  argv?: string[];
  requester: string;
  requesterName?: string;
  policyDecision: AuditPolicyDecision;
  classification?: Classification;
  approver?: string;
  approverName?: string;
  status: AuditStatus;
  exitCode?: number;
  durationMs?: number;
  reason?: string;
};

export type AuditHistoryFilters = {
  host?: string;
  status?: AuditStatus;
  text?: string;
  cursor?: string;
  limit?: number;
};

export type AuditHistoryPage = {
  entries: AuditHistoryRow[];
  nextCursor?: string;
  limit: number;
};

export type AuditHistoryRecord = {
  row: AuditHistoryRow;
  cursorAt: string;
  creationSequence: number;
  source: AuditHistoryRow["source"];
};

const terminalState: Record<string, AuditStatus> = {
  "operation.succeeded": "succeeded",
  "operation.failed": "failed",
  "operation.unknown": "unknown",
};

const operationEvents = new Set([
  "operation.planned",
  "operation.decided",
  "operation.executing",
  "operation.succeeded",
  "operation.failed",
  "operation.unknown",
]);

function clientName(id: string | undefined, names: Record<string, string>) {
  return id ? names[id] : undefined;
}

function policyOf(event: AuditEvent): AuditPolicyDecision {
  if (event.event === "operation.decided")
    return event.decision === "approve" ? "allowed" : "refused";
  return event.classification === "inspect" ? "allowed" : "needs-approval";
}

function baseRow(
  id: string,
  sequence: number,
  at: string,
  event: AuditEvent,
  names: Record<string, string>,
): AuditHistoryRow {
  return {
    id,
    sequence,
    at,
    source: "control-plane",
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(event.op ? { operation: event.op } : {}),
    ...(event.host ? { host: event.host } : {}),
    ...(event.argv ? { argv: redactArgv(event.argv) } : {}),
    requester: event.client ?? "unknown",
    ...(clientName(event.client, names)
      ? { requesterName: clientName(event.client, names) }
      : {}),
    policyDecision: policyOf(event),
    ...(event.classification ? { classification: event.classification } : {}),
    status: "pending",
    ...(event.reason ? { reason: event.reason } : {}),
  };
}

export function auditHistoryRows(
  entries: readonly AuditEntry[],
  names: Record<string, string>,
): AuditHistoryRecord[] {
  const operations = new Map<string, AuditHistoryRecord>();
  const startedAt = new Map<string, number>();
  const attempts: AuditHistoryRecord[] = [];
  for (const entry of entries) {
    const event = entry.event;
    if (event.event === "request.rejected") {
      const prior = event.operationId
        ? operations.get(event.operationId)?.row
        : undefined;
      const policyDecision = /approval|required|approved/i.test(
        event.reason ?? "",
      )
        ? "needs-approval"
        : "refused";
      const row = baseRow(
        `attempt-${entry.seq}`,
        entry.seq,
        entry.at,
        {
          ...event,
          ...(prior?.host ? { host: prior.host } : {}),
          ...(prior?.argv ? { argv: prior.argv } : {}),
          ...(prior?.classification
            ? { classification: prior.classification }
            : {}),
        },
        names,
      );
      row.status =
        policyDecision === "needs-approval" ? "approval-required" : "refused";
      row.policyDecision = policyDecision;
      if (!row.operation && prior?.operation) row.operation = prior.operation;
      attempts.push({
        row,
        cursorAt: entry.at,
        creationSequence: entry.seq,
        source: "control-plane",
      });
      continue;
    }
    if (!operationEvents.has(event.event)) continue;
    const id = event.operationId ?? `entry-${entry.seq}`;
    let record = operations.get(id);
    if (!record) {
      record = {
        row: baseRow(id, entry.seq, entry.at, event, names),
        cursorAt: entry.at,
        creationSequence: entry.seq,
        source: "control-plane",
      };
      operations.set(id, record);
    }
    const row = record.row;
    row.sequence = entry.seq;
    if (event.event === "operation.planned") {
      row.at = entry.at;
      row.operation = "control plan";
      row.host = event.host ?? row.host;
      row.argv = event.argv ? redactArgv(event.argv) : row.argv;
      row.requester = event.client ?? row.requester;
      row.requesterName = clientName(event.client, names);
      row.classification = event.classification ?? row.classification;
      row.policyDecision = policyOf(event);
      row.status = "pending";
      continue;
    }
    if (event.event === "operation.decided") {
      if (event.client) {
        row.approver = event.client;
        row.approverName = clientName(event.client, names);
      }
      row.policyDecision = policyOf(event);
      row.status = event.decision === "approve" ? "approved" : "refused";
      row.reason = event.decision === "reject" ? "rejected" : row.reason;
      continue;
    }
    if (event.event === "operation.executing") {
      if (!row.operation) row.operation = "control operation";
      row.at = entry.at;
      startedAt.set(id, Date.parse(entry.at));
      row.host = event.host ?? row.host;
      row.argv = event.argv ? redactArgv(event.argv) : row.argv;
      row.requester = event.client ?? row.requester;
      row.requesterName = clientName(event.client, names) ?? row.requesterName;
      row.classification = event.classification ?? row.classification;
      row.policyDecision = policyOf(event);
      row.status = "executing";
      row.reason = event.reason ?? row.reason;
      continue;
    }
    const final = terminalState[event.event];
    if (final) {
      row.status = final;
      row.exitCode = event.exitCode;
      row.reason = event.reason ?? row.reason;
      const start = startedAt.get(id);
      const elapsed =
        start === undefined ? undefined : Date.parse(entry.at) - start;
      if (elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0)
        row.durationMs = elapsed;
    }
  }
  return [...operations.values(), ...attempts].sort(
    (a, b) => b.creationSequence - a.creationSequence,
  );
}

export function commandHistoryRows(
  entries: readonly CommandHistoryEntry[],
): AuditHistoryRecord[] {
  const byOperation = new Map<string, AuditHistoryRecord>();
  for (const entry of entries) {
    let record = byOperation.get(entry.operationId);
    if (!record) {
      record = {
        source: "command-history",
        cursorAt: entry.at,
        creationSequence: entry.sequence,
        row: {
          id: `command-${entry.operationId}`,
          sequence: entry.sequence,
          at: entry.at,
          source: "command-history",
          operationId: entry.operationId,
          operation: "command",
          host: entry.host,
          argv: redactCommandHistoryArgv(entry.argv),
          requester: entry.requester,
          ...(entry.requesterName
            ? { requesterName: entry.requesterName }
            : {}),
          policyDecision: entry.policyDecision,
          ...(entry.classification
            ? { classification: entry.classification }
            : {}),
          ...(entry.approver ? { approver: entry.approver } : {}),
          status: entry.status,
        },
      };
      byOperation.set(entry.operationId, record);
    }
    record.row.sequence = entry.sequence;
    record.row.at = entry.at;
    record.row.argv = redactCommandHistoryArgv(entry.argv);
    record.row.policyDecision = entry.policyDecision;
    record.row.status = entry.status;
    if (entry.requester) record.row.requester = entry.requester;
    if (entry.requesterName) record.row.requesterName = entry.requesterName;
    if (entry.classification) record.row.classification = entry.classification;
    if (entry.approver) record.row.approver = entry.approver;
    if (entry.exitCode !== undefined) record.row.exitCode = entry.exitCode;
    if (entry.durationMs !== undefined)
      record.row.durationMs = entry.durationMs;
    if (entry.reason) record.row.reason = entry.reason;
  }
  return [...byOperation.values()];
}

export function auditHistory(
  entries: readonly AuditEntry[],
  names: Record<string, string> = {},
  filters: AuditHistoryFilters = {},
): AuditHistoryPage {
  return auditHistoryFromRows(auditHistoryRows(entries, names), filters);
}

export function auditHistoryFromRows(
  rows: readonly AuditHistoryRecord[],
  filters: AuditHistoryFilters = {},
): AuditHistoryPage {
  const limit = Math.max(1, Math.min(100, Math.trunc(filters.limit ?? 50)));
  const query = filters.text?.trim().toLocaleLowerCase();
  const cursor = decodeAuditCursor(filters.cursor);
  const filteredRows = rows
    .filter(({ row }) => {
      if (filters.host && row.host !== filters.host) return false;
      if (filters.status && row.status !== filters.status) return false;
      if (!query) return true;
      return [
        row.operationId,
        row.operation,
        row.host,
        row.requester,
        row.requesterName,
        row.approver,
        row.approverName,
        row.policyDecision,
        row.status,
        row.reason,
        row.classification,
        ...(row.argv ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    })
    .sort(compareRecords);
  const afterCursor = cursor
    ? filteredRows.filter((record) => compareKey(recordKey(record), cursor) > 0)
    : filteredRows;
  const page = afterCursor.slice(0, limit);
  return {
    entries: page.map(({ row }) => row),
    limit,
    ...(afterCursor.length > limit && page.length
      ? {
          nextCursor: encodeAuditCursor(
            recordKey(page.at(-1) as AuditHistoryRecord),
          ),
        }
      : {}),
  };
}

type AuditCursor = {
  at: string;
  source: AuditHistoryRow["source"];
  sequence: number;
  id: string;
};

function recordKey(record: AuditHistoryRecord): AuditCursor {
  return {
    at: record.cursorAt,
    source: record.source,
    sequence: record.creationSequence,
    id: record.row.id,
  };
}

function compareKey(a: AuditCursor, b: AuditCursor): number {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  if (a.source !== b.source) return a.source > b.source ? -1 : 1;
  if (a.sequence !== b.sequence) return b.sequence - a.sequence;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

function compareRecords(a: AuditHistoryRecord, b: AuditHistoryRecord): number {
  return compareKey(recordKey(a), recordKey(b));
}

function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeAuditCursor(value: string | undefined): AuditCursor | undefined {
  if (!value) return undefined;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as AuditCursor;
    if (
      typeof cursor.at !== "string" ||
      !Number.isFinite(Date.parse(cursor.at)) ||
      (cursor.source !== "control-plane" &&
        cursor.source !== "command-history") ||
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < 1 ||
      typeof cursor.id !== "string"
    )
      throw new Error("shape");
    return cursor;
  } catch {
    throw new HomectlError(2, "Audit cursor is invalid; refresh the history");
  }
}
