// The first screen, as in the approved design: an update notice, three status cards, what
// needs the person now, and what finished recently. Review opens a request in Accept
// requests; Compare opens a sync comparison.
import { type ReactNode, useEffect, useState } from "react";
import { bucketOf, displayStateOf, isReady, relative, shellArgv } from "./format";
import { cn } from "./lib/utils";
import { Action, PageHeading, Tag, type Tone } from "./shared";
import type { ControlOp, ControlOverview, State } from "./types";

type Release = {
  current: string;
  latest?: string;
  available: boolean;
  url?: string;
  error?: string;
};

// A device without a sync for this long is shown as stale.
const STALE_MS = 2 * 60 * 60 * 1000;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export function Dashboard({
  state,
  control,
}: {
  state: State;
  control: ControlOverview | undefined;
}) {
  const [release, setRelease] = useState<Release | undefined>();
  useEffect(() => {
    fetch("/api/update", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<Release>)
      .then(setRelease)
      .catch(() => undefined);
  }, []);

  // The Update button runs on the panel opened on this computer only.
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);

  const now = Date.now();
  const operations = control?.operations ?? [];
  const ready = operations.filter((op) => isReady(op) && !op.runsOn);
  const inspections = ready.filter((op) => op.classification === "inspect");
  const changes = ready.length - inspections.length;
  const waiting = operations.filter((op) => op.state === "pending" && op.needsApproval);
  const proposals = state.pending;
  const items = ready.length + waiting.length + proposals.length;
  const recent = operations
    .filter((op) => bucketOf(op) === "history")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5);

  // Devices: a device is in sync when control sync has seen it within the stale window.
  const syncing = control?.sync?.running === true;
  const lastSync = (id: string) =>
    control?.sync?.peers.find((p) => p.id === id)?.lastSync;
  const stale = syncing
    ? state.peers.filter((peer) => {
        const seen = lastSync(peer.id);
        return seen === undefined || now - seen > STALE_MS;
      })
    : [];
  const firstStale = stale[0];
  const firstSeen = firstStale ? lastSync(firstStale.id) : undefined;
  const audit = control?.audit;

  const readyDetail =
    [
      inspections.length ? plural(inspections.length, "inspection") : "",
      changes ? `${changes} approved change${changes === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", ") || "Nothing waiting";

  return (
    <section aria-labelledby="dashboard-title" className="grid gap-5">
      <PageHeading
        title="Dashboard"
        description="What needs your attention on this device."
      />
      {release?.available ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-info/50 bg-info/5 px-4 py-3.5"
        >
          <div className="min-w-0">
            <b>Update available: {release.latest}</b>
            <p className="text-sm text-muted-foreground">
              Panel and CLI on this device. Other devices update on their own schedule.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {release.url ? (
              <a
                href={release.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted-foreground underline underline-offset-4"
              >
                Release notes
              </a>
            ) : null}
            {local ? (
              <Action
                action="dashboard-update"
                id={release.latest ?? ""}
                label="Update"
                kind="primary"
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                Update the container by redeploying its image.
              </span>
            )}
          </div>
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Stat
          label="Ready to run"
          value={String(ready.length)}
          detail={readyDetail}
        />
        <Stat
          label="Devices"
          value={
            syncing
              ? `${state.peers.length - stale.length} / ${state.peers.length}`
              : String(state.peers.length)
          }
          detail={
            state.peers.length === 0
              ? "No paired devices yet"
              : !syncing
              ? "Control sync is not running"
              : firstStale
                ? firstSeen === undefined
                  ? `${firstStale.name}: never synced`
                  : `${firstStale.name}: no sync for ${Math.floor((now - firstSeen) / 3_600_000)} h`
                : "All devices synced recently"
          }
          detailClass={firstStale ? "text-warning" : undefined}
        />
        <Stat
          label="Audit log"
          value={audit ? (audit.ok ? "Verified" : "Attention") : "Unknown"}
          valueClass={
            audit ? (audit.ok ? "text-success" : "text-destructive-foreground") : undefined
          }
          detail={
            audit
              ? audit.ok
                ? `${audit.entries} entries · head ${audit.head.slice(0, 4)}…${audit.head.slice(-4)}`
                : (audit.error ?? "Check failed")
              : "Audit status is unavailable."
          }
        />
      </div>
      <section className="rounded-panel border border-border bg-card p-6 max-[700px]:p-[18px]">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-[-0.015em]">Needs attention</h2>
          <span className="text-sm text-muted-foreground">{plural(items, "item")}</span>
        </div>
        {items === 0 ? (
          <p className="text-muted-foreground">Nothing needs you right now.</p>
        ) : null}
        {ready.map((op) => (
          <Item
            key={op.operationId}
            tag={op.classification === "inspect" ? "inspection" : "change"}
            tone={op.classification === "inspect" ? "neutral" : "warning"}
            title={
              <>
                <b>{op.host}</b>
                <code className="font-mono text-[12px]">{shellArgv(op.argv)}</code>
              </>
            }
            detail={opDetail(op)}
            action={
              <Action action="review-operation" id={op.operationId} label="Review" />
            }
          />
        ))}
        {waiting.map((op) => (
          <Item
            key={op.operationId}
            tag="change"
            tone="warning"
            title={
              <>
                <b>{op.host}</b>
                <code className="font-mono text-[12px]">{shellArgv(op.argv)}</code>
              </>
            }
            detail="Waiting for approval by another client"
            action={
              <Action action="review-operation" id={op.operationId} label="Review" />
            }
          />
        ))}
        {proposals.map((proposal) => (
          <Item
            key={proposal.id}
            tag="sync"
            tone="info"
            title={
              <>
                <b>{proposal.remoteName}</b>
                <span>
                  proposes{" "}
                  {proposal.changes !== undefined
                    ? plural(proposal.changes, "change")
                    : "changes"}
                </span>
              </>
            }
            detail={
              proposal.conflicts
                ? `${plural(proposal.conflicts, "conflict")} to resolve`
                : "No conflicts"
            }
            action={
              <Action action="sync-preview" id={proposal.id} label="Compare" />
            }
          />
        ))}
      </section>
      <section className="rounded-panel border border-border bg-card p-6 max-[700px]:p-[18px]">
        <h2 className="mb-2 text-xl font-semibold tracking-[-0.015em]">Recent activity</h2>
        {recent.length === 0 ? (
          <p className="text-muted-foreground">No finished operations yet.</p>
        ) : null}
        {recent.map((op) => (
          <div
            key={op.operationId}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Tag tone={outcomeTone(op)}>{outcomeLabel(op)}</Tag>
              <code className="font-mono text-[12px]">{shellArgv(op.argv)}</code>
              <span className="text-sm text-muted-foreground">on {op.host}</span>
            </div>
            <time
              dateTime={op.updatedAt}
              className="text-sm whitespace-nowrap text-muted-foreground"
            >
              {relative(op.updatedAt)}
            </time>
          </div>
        ))}
      </section>
    </section>
  );
}

function opDetail(op: ControlOp) {
  if (op.classification === "inspect") return `From ${op.issuer} · no approval needed`;
  if (op.approval)
    return `Approved by ${op.approval.approver} · ${relative(op.approval.expiresAt, true)}`;
  return `From ${op.issuer}`;
}

function outcomeTone(op: ControlOp): Tone {
  if (op.state === "succeeded") return "success";
  if (op.exitCode !== undefined) return "danger";
  return "neutral";
}

function outcomeLabel(op: ControlOp) {
  if (op.exitCode !== undefined) return `exit ${op.exitCode}`;
  return displayStateOf(op);
}

function Item({
  tag,
  tone,
  title,
  detail,
  action,
}: {
  tag: string;
  tone: Tone;
  title: ReactNode;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={tone}>{tag}</Tag>
          {title}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  valueClass,
  detailClass,
}: {
  label: string;
  value: string;
  detail: string;
  valueClass?: string;
  detailClass?: string;
}) {
  return (
    <div className="rounded-panel border border-border bg-card px-4 py-3.5">
      <span className="block text-[13px] text-muted-foreground">{label}</span>
      <strong
        className={cn(
          "mt-1 block text-[26px] font-semibold tabular-nums",
          valueClass,
        )}
      >
        {value}
      </strong>
      <span
        className={cn("mt-1 block text-[13px] text-muted-foreground", detailClass)}
      >
        {detail}
      </span>
    </div>
  );
}
