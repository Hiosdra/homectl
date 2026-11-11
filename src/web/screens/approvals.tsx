// Accept requests: the audit status, the operations queue, the MCP clients and the OIDC
// settings. Accept runs an approved operation here; Deny closes a request.
import { bucketOf, displayStateOf, isReady, rankOf, relative, localStamp, shellArgv, shortHash, type ControlBucket } from "../format";
import { render, ui } from "../store";
import type { ControlAudit, ControlClient, ControlOp, OidcOverview } from "../types";
import { Action, Cell, DataTable, EmptyState, Note, PageHeading, Row, Section, Tag, type Tone } from "../shared";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { ExecutionResult, classificationTone } from "./execution";
import { cn } from "../lib/utils";

export function Approvals() {
  return (
    <>
      <PageHeading
        title="Accept requests"
        description="Plans and runs from MCP clients. Approval comes from another client; this panel runs only what is already approved."
      />
      <AuditCard audit={ui.control?.audit} />
      <Tabs
        value={ui.controlTab}
        onValueChange={(value) => {
          ui.controlTab = value === "clients" ? "clients" : "queue";
          render();
        }}
        className="mb-4"
      >
        <TabsList aria-label="Approvals sections" className="w-fit">
          <TabsTab value="queue">Operations</TabsTab>
          <TabsTab value="clients">Clients</TabsTab>
        </TabsList>
      </Tabs>
      {ui.controlTab === "queue" ? (
        <QueueSection ops={ui.control?.operations ?? []} />
      ) : (
        <>
          <OidcCard oidc={ui.control?.oidc} />
          <ClientsSection clients={ui.control?.clients ?? []} />
        </>
      )}
      {ui.controlResult ? <ExecutionResult r={ui.controlResult} /> : null}
    </>
  );
}

const STATE_TONE: Record<string, Tone> = {
  ready: "ready",
  "needs approval": "warning",
  succeeded: "success",
  failed: "danger",
  unknown: "danger",
  expired: "danger",
  executing: "info",
};

function StateTag({ label }: { label: string }) {
  return <Tag tone={STATE_TONE[label] ?? "neutral"}>{label}</Tag>;
}

function PrimaryAction({ op }: { op: ControlOp }) {
  if (isReady(op))
    return (
      <>
        <Action action="control-execute" label="Accept" id={op.operationId} kind="accept" />
        <Action action="control-deny" label="Deny" id={op.operationId} kind="danger" />
      </>
    );
  if (op.state === "pending")
    return (
      <>
        <span className="text-muted-foreground">Waiting for approval by another client</span>
        {op.needsApproval ? (
          <div className="mt-1.5">
            <Action action="control-deny" label="Deny" id={op.operationId} kind="danger" />
          </div>
        ) : null}
      </>
    );
  if (op.state === "executing") return <span className="text-muted-foreground">Running…</span>;
  if (op.state === "succeeded")
    return <span className="text-muted-foreground">Exit {op.exitCode ?? 0}</span>;
  return (
    <span className="text-muted-foreground">
      {op.reason ?? "Closed"}
      {op.exitCode !== undefined ? ` · exit ${op.exitCode}` : ""}
    </span>
  );
}

function OpAction({ op }: { op: ControlOp }) {
  // An operation another device owns runs there. This device never runs it.
  if (op.runsOn) return <span className="text-muted-foreground">Runs on {op.runsOn}</span>;
  return <PrimaryAction op={op} />;
}

// One request. On wide screens the columns are State, Host, Command, People, When, Action.
function OpRow({ op }: { op: ControlOp }) {
  const label = displayStateOf(op);
  const open = op.state === "pending" || op.state === "approved";
  const expiresAt = op.state === "approved" && op.approval ? op.approval.expiresAt : op.expiresAt;
  // Remote operations have no local expiry; they show when they last changed.
  const when = open && !op.remote ? relative(expiresAt, true) : relative(op.updatedAt);
  const approver = op.approval ? (
    op.approval.approver
  ) : op.approvedBy ? (
    op.approvedBy
  ) : op.delivery?.status === "awaiting-confirmation" ? (
    <span className="text-muted-foreground">forwarded, awaiting confirmation</span>
  ) : op.needsApproval ? (
    <span className="text-muted-foreground">awaiting approval</span>
  ) : (
    <span className="text-muted-foreground">not needed</span>
  );
  return (
    <Row
      operationId={op.operationId}
      className={cn(ui.highlightOperation === op.operationId && "bg-[#2b2545]/60")}
    >
      <Cell label="State">
        <div>
          <StateTag label={label} />
        </div>
        <div className="mt-1.5">
          <Tag tone={classificationTone(op)} className="text-[11px]">
            {op.classification}
          </Tag>
        </div>
      </Cell>
      <Cell label="Host" className="whitespace-nowrap">
        <strong>{op.host}</strong>
        {op.ownerName ? <span className="block text-sm text-muted-foreground">owner {op.ownerName}</span> : null}
      </Cell>
      <Cell label="Command" className="min-w-[200px]">
        <code className="font-mono text-[12px] break-words text-[#d7ceff]">{shellArgv(op.argv)}</code>
        <p className="mt-1 line-clamp-2 text-[13px] text-foreground">{op.impact || "—"}</p>
        <span className="mt-1.5 block text-[11px] whitespace-nowrap text-muted-foreground" title={op.fingerprint}>
          fingerprint {shortHash(op.fingerprint)}
        </span>
      </Cell>
      <Cell label="Requested → approved" className="min-w-[130px]">
        <span className="block">{op.issuer}</span>
        <span className="block text-sm text-muted-foreground">→ {approver}</span>
      </Cell>
      <Cell label="When">
        <time dateTime={op.updatedAt} title={localStamp(op.updatedAt)}>
          {when}
        </time>
      </Cell>
      <Cell label={bucketOf(op) === "history" ? "Result" : "Action"} className="whitespace-nowrap max-[700px]:whitespace-normal">
        <OpAction op={op} />
      </Cell>
    </Row>
  );
}

function AuditCard({ audit }: { audit: ControlAudit | undefined }) {
  const ok = audit?.ok === true;
  const detail = !audit ? (
    "Audit status is unavailable."
  ) : ok ? (
    <>
      {`${audit.entries} entries · `}
      <span className="whitespace-nowrap">{`head ${audit.head.slice(0, 4)}…${audit.head.slice(-4)}`}</span>
      {audit.checkedAt ? (
        <>
          {" · checked "}
          <span className="whitespace-nowrap">{localStamp(audit.checkedAt)}</span>
        </>
      ) : null}
    </>
  ) : (
    `${audit.error ?? "Check failed"}. Preserve the files and investigate.`
  );
  return (
    <Section className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 className="mb-1.5 text-xl font-semibold">Audit</h2>
        <p>
          <Tag tone={ok ? "success" : "danger"}>{ok ? "Verified" : "Attention"}</Tag>{" "}
          <span className="text-muted-foreground">{detail}</span>
        </p>
      </div>
      <Action action="control-verify" label="Verify now" />
    </Section>
  );
}

const FILTERS: [ControlBucket, string][] = [
  ["ready", "Ready to run"],
  ["needs", "Needs approval"],
  ["history", "History"],
];

function QueueSection({ ops }: { ops: ControlOp[] }) {
  if (!ops.length)
    return (
      <EmptyState title="No operations yet">
        <p>
          Plans appear here when an MCP client proposes a command with homectl_plan.
          Inspection plans are ready to run at once; changes wait for another client to
          approve.
        </p>
      </EmptyState>
    );
  const buckets: Record<ControlBucket, ControlOp[]> = { ready: [], needs: [], history: [] };
  for (const op of ops) buckets[bucketOf(op)].push(op);
  for (const list of Object.values(buckets))
    list.sort(
      (a, b) => rankOf(a) - rankOf(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const note = {
    ready:
      "Inspection plans and approved changes run from here. Operations marked Runs on belong to another device and run there. Every run is audited and single-use.",
    needs:
      "Approval comes from another authorized client's own MCP session. This panel never approves on its behalf.",
    history: "",
  }[ui.controlFilter];
  const empty = {
    ready: "Nothing is ready to run. Approved changes and inspection plans appear here.",
    needs: "Nothing is waiting for approval. New changes from MCP clients appear here.",
    history: "No finished operations yet.",
  }[ui.controlFilter];
  const visible = buckets[ui.controlFilter];
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter operations">
        {FILTERS.map(([id, label]) => (
          <Button
            type="button"
            key={id}
            variant={ui.controlFilter === id ? "default" : "ghost"}
            size="sm"
            aria-pressed={ui.controlFilter === id}
            data-action="control-filter"
            data-id={id}
            className={cn(ui.controlFilter !== id && "border-border")}
          >
            {label} <span className="tabular-nums opacity-80">{buckets[id].length}</span>
          </Button>
        ))}
      </div>
      {note ? <Note>{note}</Note> : null}
      {visible.length ? (
        <div className="mt-3">
          <DataTable head={["State", "Host", "Command", "Requested → approved", "When", "Action"]}>
            {visible.map((op) => (
              <OpRow key={op.operationId} op={op} />
            ))}
          </DataTable>
        </div>
      ) : (
        <div className="mt-4 rounded-dialog border border-dashed border-[#3b4c62] px-7 py-10 text-center text-muted-foreground">
          {empty}
        </div>
      )}
    </>
  );
}

function ClientsSection({ clients }: { clients: ControlClient[] }) {
  const intro = (
    <>
      <p className="text-muted-foreground">
        Clients are added in a private terminal, so the token file is written locally and
        never shown here. Copy this command and replace the placeholders:
      </p>
      <pre className="mt-3 overflow-auto rounded-[7px] border border-border bg-[#0d1520] p-4 font-mono text-[12px] whitespace-pre-wrap break-words">
        {'homectl control client add codex-pc --name "Codex PC" --scopes status:read,inspect:read,plan:create --hosts <host> --token-file <path>'}
      </pre>
    </>
  );
  if (!clients.length)
    return (
      <div className="grid gap-4">
        <EmptyState title="No clients yet">
          <p>
            Each MCP client gets its own identity, scopes and host grants. Add the first one
            from a terminal.
          </p>
        </EmptyState>
        {intro}
      </div>
    );
  return (
    <div className="grid gap-4">
      {intro}
      <DataTable head={["Client", "Scopes", "Hosts", "Created", "Status", "Action"]}>
        {clients.map((c) => (
          <Row key={c.id}>
            <Cell label="Client">
              <strong>{c.name}</strong>
              <p className="mt-1">
                <code className="font-mono text-[12px]">{c.id}</code>
              </p>
              {c.oidc ? (
                <p className="mt-1">
                  <Tag title={`${c.oidc.claim} hash ${c.oidc.identityHash}`}>
                    {c.hasToken ? "OIDC + token" : "OIDC only"} · {c.oidc.issuerHost}
                  </Tag>
                </p>
              ) : null}
            </Cell>
            <Cell label="Scopes">
              <Chips items={c.scopes} />
            </Cell>
            <Cell label="Hosts">
              <Chips items={c.hosts} />
            </Cell>
            <Cell label="Created">
              <time dateTime={c.createdAt} title={localStamp(c.createdAt)}>
                {localStamp(c.createdAt)}
              </time>
            </Cell>
            <Cell label="Status">
              {c.revoked ? <Tag tone="danger">revoked</Tag> : <Tag tone="success">active</Tag>}
            </Cell>
            <Cell label="Action" className="whitespace-nowrap">
              {c.revoked ? null : (
                <Action action="control-revoke" label="Revoke" id={c.id} kind="quiet-danger" />
              )}
            </Cell>
          </Row>
        ))}
      </DataTable>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((s) => (
        <span
          key={s}
          className="rounded-full border border-border bg-popover px-2.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground"
        >
          {s}
        </span>
      ))}
    </div>
  );
}

// Read-only OIDC card with the command to change it, ready to copy.
function OidcCard({ oidc }: { oidc: OidcOverview | undefined }) {
  if (!oidc)
    return (
      <Section title="OIDC" className="mb-5">
        <p className="text-muted-foreground">
          Not configured. Static client tokens are the only credentials. Configure it from a
          private terminal:
        </p>
        <pre className="mt-3 overflow-auto rounded-[7px] border border-border bg-[#0d1520] p-4 font-mono text-[12px]">
          homectl control oidc set --issuer https://&lt;issuer&gt; --audience &lt;audience&gt;
        </pre>
      </Section>
    );
  const minutes = Math.round(oidc.maxLifetimeSeconds / 60);
  const command = `homectl control oidc set --issuer ${oidc.issuer} --audience ${oidc.audience}${oidc.jwks === "configured" ? " --jwks-url <jwks-url>" : ""} --max-lifetime ${minutes}m`;
  const facts: [string, string][] = [
    ["Issuer host", oidc.issuerHost],
    ["Audience", oidc.audience],
    [
      "JWKS source",
      oidc.jwks === "configured"
        ? `configured · ${oidc.jwksHost ?? ""}`
        : "discovery (from the issuer)",
    ],
    [
      "Last JWKS refresh",
      oidc.refreshedAt ? localStamp(oidc.refreshedAt) : "not yet (no sign-in since start)",
    ],
    ["Keys", String(oidc.keyCount)],
    ["Last error", oidc.lastError ? oidc.lastError : "none"],
    ["Max token lifetime", `${minutes} min`],
    ["Mapped clients", String(oidc.mappedClients)],
  ];
  return (
    <Section title="OIDC" className="mb-5">
      <p className="text-muted-foreground">Read-only. Change it from a private terminal.</p>
      <dl className="mt-3 grid grid-cols-[130px_minmax(0,1fr)] gap-x-4 gap-y-2.5 max-[700px]:grid-cols-[100px_minmax(0,1fr)]">
        {facts.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="m-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">Change it with:</p>
      <pre className="mt-2 overflow-auto rounded-[7px] border border-border bg-[#0d1520] p-4 font-mono text-[12px] whitespace-pre-wrap break-words">
        {command}
      </pre>
    </Section>
  );
}
