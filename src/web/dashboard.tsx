// The first screen: what needs the person now. Accept and Deny use the same
// data-action buttons as the rest of the panel, so the root handler runs them.
import { useEffect, useState } from "react";
import { displayArgv, isReady, labelOf } from "./format";
import { Action, Muted, PageHeading, Section } from "./shared";
import { Alert, AlertDescription } from "./ui/alert";
import type { ControlOverview, State } from "./types";

type Release = {
  current: string;
  latest?: string;
  available: boolean;
  url?: string;
  error?: string;
};

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

  const operations = control?.operations ?? [];
  const ready = operations.filter((op) => isReady(op) && !op.runsOn);
  const awaiting = operations.filter((op) => op.state === "pending" && op.needsApproval);
  const pairing = state.pending;
  const attention = ready.length + awaiting.length + pairing.length;

  return (
    <section aria-labelledby="dashboard-title" className="grid gap-5">
      <PageHeading title="Dashboard" description="What needs your attention on this device." />
      {release?.available ? (
        <Alert variant="info" role="status" className="flex flex-wrap items-center justify-between gap-3">
          <AlertDescription>
            Update available: <b>{release.latest}</b>. You have {release.current}.
          </AlertDescription>
          {release.url ? (
            <a href={release.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              Release notes
            </a>
          ) : null}
        </Alert>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        <Stat label="Ready to run" value={ready.length} />
        <Stat label="Waiting for approval" value={awaiting.length} />
        <Stat label="Devices" value={state.peers.length} />
      </div>
      <Section title="Needs attention">
        {attention === 0 ? <Muted>Nothing needs you right now.</Muted> : null}
        {ready.map((op) => (
          <div
            key={op.operationId}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <b>{op.host}</b> <code className="font-mono text-[12px]">{displayArgv(op.argv)}</code>
              <p className="text-sm text-muted-foreground">{labelOf(op)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Action action="control-execute" id={op.operationId} label="Accept" kind="accept" />
              <Action action="control-deny" id={op.operationId} label="Deny" kind="danger" />
            </div>
          </div>
        ))}
        {awaiting.map((op) => (
          <div
            key={op.operationId}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <b>{op.host}</b> <code className="font-mono text-[12px]">{displayArgv(op.argv)}</code>
              <p className="text-sm text-muted-foreground">Waiting for approval by another client</p>
            </div>
            <Action action="control-deny" id={op.operationId} label="Deny" kind="danger" />
          </div>
        ))}
        {pairing.map((request) => (
          <div
            key={request.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <b>Pairing request from {request.remoteName}</b>
              <p className="text-sm text-muted-foreground">Compare the phrase on both screens in Sync.</p>
            </div>
            <a
              href="#sync"
              data-view="sync"
              className="rounded-lg border border-border px-3 py-1.5 no-underline hover:bg-accent"
            >
              Open Sync
            </a>
          </div>
        ))}
      </Section>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-panel border border-border bg-card px-4 py-3.5">
      <span className="block text-[13px] text-muted-foreground">{label}</span>
      <strong className="text-[26px] font-semibold tabular-nums">{value}</strong>
    </div>
  );
}
