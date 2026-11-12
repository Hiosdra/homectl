// Accept requests, as in the approved design: the requests in three tabs, a table, and a
// side panel for the one that is open. Accept runs an approved plan here; Deny cancels it.
import {
  type ControlBucket,
  bucketOf,
  displayStateOf,
  isReady,
  localStamp,
  rankOf,
  relative,
  shellArgv,
  shortHash,
} from "../format";
import { cn } from "../lib/utils";
import { render, ui } from "../store";
import { Action, Cell, DataTable, EmptyState, PageHeading, Pre, Row, Tag, type Tone } from "../shared";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import type { ControlOp } from "../types";
import { ExecutionResult, classificationTone } from "./execution";

const TABS: [ControlBucket, string][] = [
  ["ready", "To run"],
  ["needs", "Waiting for approval"],
  ["history", "History"],
];

// One plain sentence per tab, for people who are new to requests.
const TAB_HELP: Record<ControlBucket, string> = {
  ready: "Requests you can run here. Open one to read the command, then Accept to run it or Deny to close it.",
  needs: "Requests another client has to approve before they can run. Nothing runs until then.",
  history: "Finished requests: what ran, what was denied, and when.",
};

const STATE_TONE: Record<string, Tone> = {
  ready: "success",
  "needs approval": "warning",
  succeeded: "success",
  failed: "danger",
  unknown: "danger",
  expired: "danger",
  denied: "danger",
  executing: "info",
};

const EMPTY: Record<ControlBucket, string> = {
  ready: "Nothing is ready to run. Approved changes and inspection plans appear here.",
  needs: "Nothing is waiting for approval. New changes from MCP clients appear here.",
  history: "No finished operations yet.",
};

export function Approvals() {
  const ops = ui.control?.operations ?? [];
  const buckets: Record<ControlBucket, ControlOp[]> = { ready: [], needs: [], history: [] };
  for (const op of ops) buckets[bucketOf(op)].push(op);
  for (const list of Object.values(buckets))
    list.sort(
      (a, b) => rankOf(a) - rankOf(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  // As in the approved design, the To run tab opens its first request until the person
  // picks another one or closes the drawer (which stores an empty selection).
  const chosen = ui.selectedOperation;
  const selectedId =
    chosen === undefined
      ? ui.controlFilter === "ready"
        ? buckets.ready[0]?.operationId
        : undefined
      : chosen || undefined;
  const selected = ops.find((op) => op.operationId === selectedId);
  const visible = buckets[ui.controlFilter];
  return (
    <>
      <PageHeading
        title="Accept requests"
        description="Plans from MCP clients. This panel runs only ready plans. Another client approves them."
      />
      <div className={cn("grid gap-5", selected && "min-[1360px]:grid-cols-[minmax(0,1fr)_360px]")}>
        <div className="min-w-0">
          <Tabs
            value={ui.controlFilter}
            onValueChange={(value) => {
              ui.controlFilter = value as ControlBucket;
              render();
            }}
            className="mb-4"
          >
            <TabsList aria-label="Filter operations" className="w-fit">
              {TABS.map(([id, label]) => (
                <TabsTab key={id} value={id}>
                  {label} {buckets[id].length}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
          <p className="mb-4 text-sm text-muted-foreground">{TAB_HELP[ui.controlFilter]}</p>
          {visible.length ? (
            <DataTable head={["State", "Host", "Command", "Requested by", "When", ""]}>
              {visible.map((op) => (
                <OperationRow key={op.operationId} op={op} selectedId={selectedId} />
              ))}
            </DataTable>
          ) : (
            <EmptyState>
              <p>{EMPTY[ui.controlFilter]}</p>
            </EmptyState>
          )}
        </div>
        {selected ? <Details op={selected} /> : null}
      </div>
    </>
  );
}

function OperationRow({ op, selectedId }: { op: ControlOp; selectedId?: string }) {
  const other = op.runsOn !== undefined;
  const label = displayStateOf(op);
  const open = op.state === "pending" || op.state === "approved";
  const expiresAt = op.approval && op.state === "approved" ? op.approval.expiresAt : op.expiresAt;
  const when = open && !op.remote ? relative(expiresAt, true) : relative(op.updatedAt);
  const approver =
    op.approval?.approver ??
    op.approvedBy ??
    (op.classification === "inspect"
      ? "no approval needed"
      : op.needsApproval
        ? "awaiting approval"
        : "not needed");
  return (
    <Row operationId={op.operationId} className={cn(selectedId === op.operationId && "bg-accent/50")}>
      <Cell label="State" className="whitespace-nowrap">
        <div className="flex flex-wrap gap-1.5">
          <Tag tone={other ? "info" : (STATE_TONE[label] ?? "neutral")}>{other ? "other device" : label}</Tag>
          {other ? null : <Tag tone={classificationTone(op)}>{op.classification === "inspect" ? "inspection" : op.classification}</Tag>}
        </div>
      </Cell>
      <Cell label="Host">
        <b>{op.host}</b>
        {other ? <p className="text-xs text-muted-foreground">owned by {op.ownerName ?? op.runsOn}</p> : null}
      </Cell>
      <Cell label="Command" className="min-w-[200px]">
        <code className="font-mono text-[12px] break-words">{shellArgv(op.argv)}</code>
        <p className="text-sm text-muted-foreground">{op.impact || "—"}</p>
      </Cell>
      <Cell label="Requested by">
        {op.issuer}
        <p className="text-sm text-muted-foreground">→ {approver}</p>
      </Cell>
      <Cell label="When" className="whitespace-nowrap">
        <time dateTime={op.updatedAt} title={localStamp(op.updatedAt)}>{when}</time>
      </Cell>
      <Cell label="Action" className="whitespace-nowrap">
        {other ? (
          <span className="text-sm text-muted-foreground">Open {op.runsOn} to run it</span>
        ) : (
          <Action action="open-operation" id={op.operationId} label="Open" />
        )}
      </Cell>
    </Row>
  );
}

// The side panel for one request: what it does, who asked, who approved, and the
// actions. The result of a run appears here too.
function Details({ op }: { op: ControlOp }) {
  const ready = isReady(op) && !op.runsOn;
  const open = op.state === "pending" || op.state === "approved";
  const result = ui.controlResult?.operation.operationId === op.operationId ? ui.controlResult : undefined;
  return (
    <aside
      className="grid content-start gap-4 rounded-panel border border-border bg-card p-5 max-[700px]:fixed max-[700px]:inset-0 max-[700px]:z-30 max-[700px]:overflow-y-auto max-[700px]:rounded-none max-[700px]:border-0 max-[700px]:bg-background max-[700px]:p-4"
      aria-label="Request details"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">{op.host}</h2>
        <Action action="close-operation" label="Close" kind="quiet" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={STATE_TONE[displayStateOf(op)] ?? "neutral"}>{displayStateOf(op)}</Tag>
        <Tag tone={classificationTone(op)}>{op.classification === "inspect" ? "inspection" : op.classification}</Tag>
        {op.fingerprint ? <Tag tone="success">device signature ✓</Tag> : null}
      </div>
      <Pre>{`$ ${shellArgv(op.argv)}`}</Pre>
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Effect</dt>
        <dd>{op.impact || "—"}</dd>
        <dt className="text-muted-foreground">Requested by</dt>
        <dd>{op.issuer}</dd>
        <dt className="text-muted-foreground">Approved by</dt>
        <dd>
          {op.approval
            ? `${op.approval.approver} · ${relative(op.approval.expiresAt, true)}`
            : (op.approvedBy ?? (op.classification === "inspect" ? "not needed" : "waiting for approval"))}
        </dd>
        <dt className="text-muted-foreground">Fingerprint</dt>
        <dd className="font-mono text-[12px]">{shortHash(op.fingerprint)}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        {ready ? (
          <Action action="control-execute" id={op.operationId} label="Accept" kind="accept" />
        ) : (
          <Button type="button" disabled>
            Accept
          </Button>
        )}
        {open ? <Action action="control-deny" id={op.operationId} label="Deny" kind="danger" /> : null}
      </div>
      {result ? <ExecutionResult r={result} /> : null}
      <p className="text-xs text-muted-foreground">
        Accept asks for confirmation, then runs the plan. Accept is available once another
        client has approved it. Deny cancels the plan. The result (stdout, stderr, duration)
        appears in this same panel.
      </p>
    </aside>
  );
}
