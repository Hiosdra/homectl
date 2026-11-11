// Sync, the device list: one card per paired computer with its sync status, key, grants and
// lease, plus the three-step pairing dialog and the changes applied on their own.
import { useState } from "react";
import { cn } from "../lib/utils";
import { PairWizard } from "../pair-wizard";
import { ui } from "../store";
import { Action, Muted, Note, PageHeading, Section, Tag } from "../shared";
import { Output } from "./output";

const HOUR = 3_600_000;

export function Devices() {
  const syncing = ui.control?.sync?.running === true;
  const sync = ui.control?.sync;
  return (
    <>
      <PageHeading
        title="Sync"
        description="Paired computers. Sync data between them."
        actions={
          <Action
            action="pair-open-wizard"
            label="Pair device"
            kind="primary"
          />
        }
      />
      {ui.applied ? <AppliedChanges /> : null}
      <div className="grid gap-4">
        {ui.state.peers.length ? (
          ui.state.peers.map((peer) => <DeviceCard key={peer.id} id={peer.id} name={peer.name} />)
        ) : (
          <Section title="No paired devices yet">
            <Muted>
              Pair a computer to sync entries between them. Check that both show the same phrase before confirming.
            </Muted>
          </Section>
        )}
      </div>
      {sync?.conflicts.length ? (
        <div className="mt-5">
          <Note>
            {sync.conflicts.length} control conflict{sync.conflicts.length === 1 ? "" : "s"}: resolve them from a
            private terminal with homectl control resolve.
          </Note>
        </div>
      ) : null}
      {syncing ? null : (
        <div className="mt-3">
          <Note>Control sync runs while this homectl workspace is open.</Note>
        </div>
      )}
      <Output />
      <PairWizard />
    </>
  );
}

// How long ago a device last synced, and whether that is stale.
function syncAge(lastSync: number | undefined) {
  if (lastSync === undefined) return { text: "never synced", stale: true };
  const ms = Date.now() - lastSync;
  if (ms < 60_000) return { text: `synced ${Math.max(1, Math.round(ms / 1000))} s ago`, stale: false };
  if (ms < HOUR) return { text: `synced ${Math.round(ms / 60_000)} min ago`, stale: false };
  if (ms < 2 * HOUR) return { text: `synced ${Math.round(ms / HOUR)} h ago`, stale: false };
  return { text: `no sync ${Math.round(ms / HOUR)} h`, stale: true };
}

function DeviceCard({ id, name }: { id: string; name: string }) {
  const peer = ui.state.peers.find((p) => p.id === id);
  const control = ui.control?.sync?.peers.find((p) => p.id === id);
  const device = ui.control?.devices?.peers.find((p) => p.id === id);
  const age = ui.control?.sync?.running ? syncAge(control?.lastSync) : undefined;
  const leaseOk = control?.leaseOk;
  const suspended = control?.suspended !== undefined;
  const hosts = peer?.permissions.operations.length ?? 0;
  const key = device?.fingerprint
    ? `key ${device.fingerprint.slice(0, 4)} ${device.fingerprint.slice(4, 8)} …`
    : device?.legacy
      ? "re-pair to enable control sync"
      : "key not reported";
  return (
    <article className="grid gap-3 rounded-panel border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{name}</h2>
        {age ? (
          <span className={cn("flex items-center gap-2 text-sm", age.stale ? "text-warning" : "text-success")}>
            <span className="size-2 rounded-full bg-current" aria-hidden="true" />
            {age.text}
          </span>
        ) : null}
      </div>
      <p className="font-mono text-xs text-muted-foreground">{key}</p>
      <div className="flex flex-wrap gap-1.5">
        {peer?.permissions.sync ? <Tag>entry sync</Tag> : null}
        <Tag>{`owns ${hosts} host${hosts === 1 ? "" : "s"}`}</Tag>
        {leaseOk === undefined ? null : suspended ? (
          <Tag tone="warning">suspended</Tag>
        ) : leaseOk ? (
          <Tag tone="success">lease ok</Tag>
        ) : (
          <Tag tone="warning">lease expired</Tag>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Action action="sync-start" label="Compare and sync" id={id} />
        <Action action="peer-permissions" label="Permissions" id={id} kind="quiet" />
        {leaseOk === false && !suspended ? (
          <Action action="control-peer-suspend" label="Suspend lease…" id={id} kind="quiet" />
        ) : null}
        <DeviceMenu id={id} />
      </div>
    </article>
  );
}

function DeviceMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label="More actions for this device"
        onClick={() => setOpen(!open)}
        className="h-8 rounded-lg px-2.5 text-sm hover:bg-accent"
      >
        ⋯
      </button>
      {open ? (
        <div className="absolute right-0 z-10 mt-1 grid min-w-40 gap-1 rounded-lg border border-border bg-popover p-1 shadow-md">
          <Action action="peer-status" label="Status" id={id} kind="quiet" />
          <Action action="peer-forget" label="Remove trust" id={id} kind="quiet-danger" />
        </div>
      ) : null}
    </div>
  );
}

function AppliedChanges() {
  const applied = ui.applied;
  if (!applied) return null;
  return (
    <Section
      title="Applied changes"
      className="mb-6 max-[700px]:fixed max-[700px]:inset-0 max-[700px]:z-30 max-[700px]:overflow-y-auto max-[700px]:rounded-none max-[700px]:border-0 max-[700px]:bg-background max-[700px]:p-4"
    >
      <Muted>
        {applied.items.length} change{applied.items.length === 1 ? "" : "s"} applied automatically. Conflicts, if any,
        were left for your choice.
      </Muted>
      <ul className="mt-3 grid gap-2">
        {applied.items.map((item) => (
          <li key={item} className="flex items-center gap-2 text-sm">
            <span className="text-success" aria-hidden="true">✓</span>
            <code className="font-mono text-[12px]">{item}</code>
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <Action action="dismiss-applied" label="Done" kind="secondary" />
      </div>
    </Section>
  );
}

