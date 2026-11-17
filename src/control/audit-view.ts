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
  cursor?: number;
  limit?: number;
};

export type AuditHistoryPage = {
  entries: AuditHistoryRow[];
  nextCursor?: number;
  limit: number;
};

const terminalState: Record<string, AuditStatus> = {
  "operation.succeeded": "succeeded",
  "operation.failed": "failed",
  "operation.unknown": "unknown",
  "command.succeeded": "succeeded",
  "command.failed": "failed",
  "command.unknown": "unknown",
};

const operationEvents = new Set([
  "operation.planned",
  "operation.decided",
  "operation.executing",
  "operation.succeeded",
  "operation.failed",
  "operation.unknown",
  "command.started",
  "command.succeeded",
  "command.failed",
  "command.unknown",
  "command.refused",
  "command.approval-required",
]);

function clientName(id: string | undefined, names: Record<string, string>) {
  return id ? names[id] : undefined;
}

function policyOf(event: AuditEvent): AuditPolicyDecision {
  if (event.policyDecision) return event.policyDecision;
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
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(event.op ? { operation: event.op } : {}),
    ...(event.host ? { host: event.host } : {}),
    ...(event.argv ? { argv: redactArgv(event.argv) } : {}),
    requester: event.device ?? event.client ?? "unknown",
    ...(event.deviceName || clientName(event.client, names)
      ? { requesterName: event.deviceName ?? clientName(event.client, names) }
      : {}),
    policyDecision: policyOf(event),
    ...(event.classification ? { classification: event.classification } : {}),
    ...(event.approver ? { approver: event.approver } : {}),
    ...(clientName(event.approver, names)
      ? { approverName: clientName(event.approver, names) }
      : {}),
    status: "pending",
    ...(event.reason ? { reason: event.reason } : {}),
  };
}

function rowsFromJournal(
  entries: AuditEntry[],
  names: Record<string, string>,
): AuditHistoryRow[] {
  const operations = new Map<string, AuditHistoryRow>();
  const startedAt = new Map<string, number>();
  const attempts: AuditHistoryRow[] = [];
  for (const entry of entries) {
    const event = entry.event;
    if (event.event === "request.rejected") {
      const prior = event.operationId
        ? operations.get(event.operationId)
        : undefined;
      const needsApproval = /approval|required|approved/i.test(
        event.reason ?? "",
      );
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
          policyDecision: needsApproval ? "needs-approval" : "refused",
        },
        names,
      );
      row.status = needsApproval ? "approval-required" : "refused";
      if (!row.operation && prior?.operation) row.operation = prior.operation;
      attempts.push(row);
      continue;
    }
    if (!operationEvents.has(event.event)) continue;
    const id = event.operationId ?? `entry-${entry.seq}`;
    let row = operations.get(id);
    if (!row) {
      row = baseRow(id, entry.seq, entry.at, event, names);
      operations.set(id, row);
    }
    row.sequence = entry.seq;
    if (event.event === "operation.planned") {
      row.at = entry.at;
      row.operation = "control plan";
      row.host = event.host ?? row.host;
      row.argv = event.argv ? redactArgv(event.argv) : row.argv;
      row.requester = event.device ?? event.client ?? row.requester;
      row.requesterName = event.deviceName ?? clientName(event.client, names);
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
      row.status = event.decision === "approve" ? "approved" : "failed";
      row.reason = event.decision === "reject" ? "rejected" : row.reason;
      continue;
    }
    if (event.approver) {
      row.approver = event.approver;
      row.approverName = clientName(event.approver, names);
    }
    if (
      event.event === "operation.executing" ||
      event.event === "command.started"
    ) {
      if (!row.operation)
        row.operation = event.event.startsWith("command")
          ? "command"
          : "control operation";
      row.at = entry.at;
      startedAt.set(id, Date.parse(entry.at));
      row.host = event.host ?? row.host;
      row.argv = event.argv ? redactArgv(event.argv) : row.argv;
      row.requester = event.device ?? event.client ?? row.requester;
      row.requesterName =
        event.deviceName ??
        clientName(event.client, names) ??
        row.requesterName;
      row.classification = event.classification ?? row.classification;
      row.policyDecision = policyOf(event);
      row.status = "executing";
      row.reason = event.reason ?? row.reason;
      continue;
    }
    if (
      event.event === "command.refused" ||
      event.event === "command.approval-required"
    ) {
      row.operation = "command";
      row.host = event.host ?? row.host;
      row.argv = event.argv ? redactArgv(event.argv) : row.argv;
      row.classification = event.classification ?? row.classification;
      row.policyDecision =
        event.event === "command.approval-required"
          ? "needs-approval"
          : "refused";
      row.status =
        event.event === "command.approval-required"
          ? "approval-required"
          : "refused";
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
    (a, b) => b.sequence - a.sequence,
  );
}

export function auditHistory(
  entries: AuditEntry[],
  names: Record<string, string> = {},
  filters: AuditHistoryFilters = {},
): AuditHistoryPage {
  const limit = Math.max(1, Math.min(100, Math.trunc(filters.limit ?? 50)));
  const query = filters.text?.trim().toLocaleLowerCase();
  const rows = rowsFromJournal(entries, names).filter((row) => {
    if (filters.host && row.host !== filters.host) return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.cursor !== undefined && row.sequence >= filters.cursor)
      return false;
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
  });
  const page = rows.slice(0, limit);
  return {
    entries: page,
    limit,
    ...(rows.length > limit && page.length
      ? { nextCursor: page.at(-1)?.sequence }
      : {}),
  };
}
