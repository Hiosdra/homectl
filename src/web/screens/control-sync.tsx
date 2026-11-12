// Control sync: the lease each paired device holds, and the operations two devices
// both claim. Conflicts are resolved from a terminal; the panel only reports them.
import { localStamp, relative } from "../format";
import { ui } from "../store";
import type { ControlSync } from "../types";
import { Action, Cell, DataTable, Note, Row, Section, Tag } from "../shared";

export function ControlSyncSection() {
  if (!ui.control)
    return (
      <Section title="Control sync">
        <p className="text-muted-foreground">
          Control status is unavailable right now. Refresh to try again.
        </p>
      </Section>
    );
  const sync = ui.control.sync;
  if (sync?.disabledBy)
    return (
      <Section title="Control sync">
        <p className="text-muted-foreground">
          Control sync is disabled by {sync.disabledBy} on this device. Operations that
          have paired peers wait for a sync.
        </p>
      </Section>
    );
  if (!sync?.running)
    return (
      <Section title="Control sync">
        <p className="text-muted-foreground">
          Control sync runs while this homectl workspace is open.
        </p>
      </Section>
    );
  const now = Date.now();
  const names = sync.names ?? {};
  return (
    <Section title="Control sync">
      <p className="text-muted-foreground">
        Approvals and executions travel on this sync. It updates every 15 seconds while
        this workspace is open.
      </p>
      {sync.peers.length ? (
        <div className="mt-4">
          <DataTable head={["Device", "Last sync", "Lease", "Backoff", "Status", "Action"]}>
            {sync.peers.map((p) => (
              <SyncRow key={p.id} p={p} now={now} />
            ))}
          </DataTable>
        </div>
      ) : (
        <p className="mt-3 text-muted-foreground">
          No paired devices take part in control sync yet.
        </p>
      )}
      {sync.conflicts.length ? (
        <div className="mt-5 grid gap-3">
          <h3 className="text-[15px] font-semibold">Control conflicts</h3>
          <Note>
            Two different handoffs were recorded for the same operation. Nobody can run it
            until the conflict is resolved. Choose the owner here; that device must accept
            on its own side before the resolution applies.
          </Note>
          {sync.conflicts.map((c) => (
            <ConflictRow key={c.opId} c={c} names={names} resolutions={sync.resolutions ?? []} />
          ))}
        </div>
      ) : (
        <Note>No control conflicts.</Note>
      )}
      {Object.entries(sync.blocked).map(([origin, reason]) => (
        <Note key={origin}>
          Log from {names[origin] ?? origin} is blocked: {reason}
        </Note>
      ))}
    </Section>
  );
}

// One paired device. A suspended device is out of this device's lease until it syncs
// again or is resumed; a legacy device has no control sync at all.
function SyncRow({ p, now }: { p: ControlSync["peers"][number]; now: number }) {
  const name = (
    <Cell label="Device">
      <strong>{p.name}</strong>
    </Cell>
  );
  const lastSync =
    p.lastSync === undefined ? (
      <span className="text-muted-foreground">never</span>
    ) : (
      relative(new Date(p.lastSync).toISOString())
    );
  if (p.suspended)
    return (
      <Row>
        {name}
        <Cell label="Last sync">{lastSync}</Cell>
        <Cell label="Lease">
          <span className="text-sm text-warning">
            suspended by {p.suspended.by} at {localStamp(p.suspended.at)}
          </span>
        </Cell>
        <Cell label="Backoff">
          <span className="text-muted-foreground">—</span>
        </Cell>
        <Cell label="Status">
          <span className="text-muted-foreground">not counted in the lease</span>
        </Cell>
        <Cell label="Action" className="whitespace-nowrap max-[700px]:whitespace-normal">
          <Action action="control-peer-resume" label="Resume" id={p.id} kind="quiet" />
        </Cell>
      </Row>
    );
  if (p.excluded)
    return (
      <Row>
        {name}
        <Cell label="Last sync">
          <span className="text-muted-foreground">never (control)</span>
        </Cell>
        <Cell label="Lease">
          <span className="text-muted-foreground">excluded from lease: re-pair required</span>
        </Cell>
        <Cell label="Backoff">
          <span className="text-muted-foreground">—</span>
        </Cell>
        <Cell label="Status">
          <Tag tone="warning" title={p.refused ?? ""}>
            re-pair required
          </Tag>
        </Cell>
        <Cell label="Action">
          <span className="text-muted-foreground">—</span>
        </Cell>
      </Row>
    );
  const retry =
    p.nextAttemptAt !== undefined && (p.failures ?? 0) > 0 && p.nextAttemptAt > now
      ? `retry ${localStamp(new Date(p.nextAttemptAt).toISOString())}`
      : "none";
  return (
    <Row>
      {name}
      <Cell label="Last sync">{lastSync}</Cell>
      <Cell label="Lease">
        {p.leaseOk ? (
          "ok"
        ) : (
          <span className="text-destructive-foreground">expired: waiting for sync</span>
        )}
      </Cell>
      <Cell label="Backoff">{retry}</Cell>
      <Cell label="Status">
        {p.lastError ? (
          <span className="text-destructive-foreground">{p.lastError}</span>
        ) : (
          <Tag tone="success">ok</Tag>
        )}
      </Cell>
      <Cell label="Action" className="whitespace-nowrap max-[700px]:whitespace-normal">
        <Action
          action="control-peer-suspend"
          label="Suspend from lease"
          id={p.id}
          kind="quiet-danger"
        />
      </Cell>
    </Row>
  );
}

// One conflicting operation: the candidates, any proposal waiting, and who owns it.
function ConflictRow({
  c,
  names,
  resolutions,
}: {
  c: { opId: string; epoch: number; candidates: string[] };
  names: Record<string, string>;
  resolutions: NonNullable<ControlSync["resolutions"]>;
}) {
  const mine = resolutions.filter((r) => r.opId === c.opId);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
      <div className="min-w-0 flex-1 basis-[260px]">
        <strong>
          <code>{c.opId.slice(0, 8)}</code>
        </strong>{" "}
        at epoch {c.epoch}: {c.candidates.map((id) => names[id] ?? id).join(", ")}
        {mine.map((r, i) => (
          <p key={i} className="mt-1 text-xs text-muted-foreground">
            Proposed by {names[r.resolver] ?? r.resolver}: owner {names[r.winner] ?? r.winner}.
          </p>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 text-sm text-muted-foreground">
        Two devices claim this operation. Resolve it from a private terminal with{" "}
        <code>home-ctl control resolve</code>.
      </div>
    </div>
  );
}
