import { useEffect } from "react";
import { containsRedactionMarker } from "../../control/redact";
import { formatMs, localStamp } from "../format";
import { loadAudit, report, ui } from "../store";
import type { AuditHistoryRow } from "../types";
import { Action, Note, PageHeading, Section, Tag } from "../shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function canSaveAuditRow(
  row: Pick<AuditHistoryRow, "host" | "argv">,
): row is Pick<AuditHistoryRow, "host" | "argv"> & {
  host: string;
  argv: string[];
} {
  return Boolean(row.host && row.argv?.length && !containsRedactionMarker(row.argv));
}

export function savedCommandDraftFromAuditRow(
  row: Pick<AuditHistoryRow, "host" | "argv"> | undefined,
) {
  if (!row || !canSaveAuditRow(row))
    throw new Error("This entry has no saveable command. Redacted arguments cannot be restored.");
  return {
    name: `${row.host} ${row.argv[0]}`.slice(0, 80),
    hosts: [row.host],
    argv: row.argv,
    parameters: [],
  };
}

function AuditCard({ row }: { row: AuditHistoryRow }) {
  const canSave = canSaveAuditRow(row);
  return (
    <article className="grid gap-3 rounded-lg border border-border bg-background p-4" data-audit-entry={row.id}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{row.operation ?? "Command"} {row.host ? `on ${row.host}` : ""}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {localStamp(row.at)} · {row.requesterName ?? row.requester}
            {row.approver ? ` · approved by ${row.approverName ?? row.approver}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Tag>{row.source === "command-history" ? "Local command" : "Control-plane"}</Tag>
          <Tag tone={row.policyDecision === "allowed" ? "success" : row.policyDecision === "refused" ? "danger" : "warning"}>
            {row.policyDecision === "needs-approval" ? "Needed approval" : row.policyDecision}
          </Tag>
          <Tag>{row.status}</Tag>
        </div>
      </header>
      {row.argv?.length ? (
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Exact argv (redacted)</span>
          <code className="break-all whitespace-pre-wrap text-sm">{JSON.stringify(row.argv)}</code>
        </div>
      ) : row.operation ? null : <Note>No command details were recorded for this request.</Note>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {row.classification ? <span>Policy class: {row.classification}</span> : null}
        {row.exitCode !== undefined ? <span>Exit code: {row.exitCode}</span> : null}
        {row.durationMs !== undefined ? <span>Duration: {formatMs(row.durationMs)}</span> : null}
        {row.reason ? <span>Reason: {row.reason}</span> : null}
        {row.operationId ? <span>Operation: {row.operationId}</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {row.argv?.length ? <Action action="audit-copy-argv" id={row.id} label="Copy argv JSON" /> : null}
        {canSave ? <Action action="audit-save-command" id={row.id} label="Save as command" /> : null}
      </div>
    </article>
  );
}

export function AuditScreen() {
  useEffect(() => {
    if (!ui.auditPage) void loadAudit(true).catch((error) => report(String(error)));
  }, []);
  const page = ui.auditPage;
  return (
    <>
      <PageHeading
        title="Audit history"
        description="Read-only control-plane entries are joined with ordinary command runs from private local history. Arguments are redacted; command output is never included."
        actions={<><Action action="audit-refresh" label="Refresh" /><Action action="audit-clear" label="Clear command history" kind="quiet-danger" /></>}
      />
      <Section>
        <form id="audit-filter-form" className="grid gap-4 md:grid-cols-4 md:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor="audit-host">Host</Label>
            <select id="audit-host" name="host" defaultValue={ui.auditFilters.host} className="h-10 rounded-md border border-input bg-background px-3">
              <option value="">All hosts</option>
              {Object.keys(ui.state.inventory.machines).sort().map((host) => <option key={host} value={host}>{host}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-status">Status</Label>
            <select id="audit-status" name="status" defaultValue={ui.auditFilters.status} className="h-10 rounded-md border border-input bg-background px-3">
              <option value="">All statuses</option>
              {["pending", "approved", "executing", "succeeded", "failed", "unknown", "refused", "approval-required"].map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="audit-text">Search host, argv, identity or status</Label>
            <Input id="audit-text" name="text" maxLength={200} defaultValue={ui.auditFilters.text} />
          </div>
          <div className="md:col-span-4 md:justify-self-end"><Button type="submit">Filter history</Button></div>
        </form>
      </Section>
      <Section title={page?.entries.length ? `Entries (${page.entries.length})` : "Entries"} className="mt-5">
        {!page ? <p role="status" className="text-sm text-muted-foreground">Loading local audit history…</p> : null}
        {page?.entries.length ? (
          <div className="grid gap-3">{page.entries.map((row) => <AuditCard key={row.id} row={row} />)}</div>
        ) : page ? <p className="text-sm text-muted-foreground">No audit entries match these filters.</p> : null}
        {page?.nextCursor ? <div className="mt-4"><Action action="audit-more" label="Load 50 more" /></div> : null}
        <Note>The control-plane journal remains hash-chained and unchanged. Command history is local, rotates by age and entry count, is not included in recovery bundles or peer sync, and can be cleared separately.</Note>
      </Section>
    </>
  );
}
