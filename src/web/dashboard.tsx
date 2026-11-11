// The first screen: what needs the person now. Accept and Deny use the same
// data-action buttons as the rest of the panel, so the root handler runs them.
import { useEffect, useState } from "react";
import { displayArgv, isReady, labelOf } from "./format";
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
  const awaiting = operations.filter(
    (op) => op.state === "pending" && op.needsApproval,
  );
  const pairing = state.pending;
  const attention = ready.length + awaiting.length + pairing.length;

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <header>
        <h1 id="dashboard-title">Dashboard</h1>
        <p className="muted">What needs your attention on this device.</p>
      </header>
      {release?.available ? (
        <div className="update-banner" role="status">
          <span>
            Update available: <b>{release.latest}</b>. You have {release.current}.
          </span>
          {release.url ? (
            <a href={release.url} target="_blank" rel="noreferrer">
              Release notes
            </a>
          ) : null}
        </div>
      ) : null}
      <div className="dash-stats">
        <div className="stat-card">
          <span>Ready to run</span>
          <strong>{ready.length}</strong>
        </div>
        <div className="stat-card">
          <span>Waiting for approval</span>
          <strong>{awaiting.length}</strong>
        </div>
        <div className="stat-card">
          <span>Devices</span>
          <strong>{state.peers.length}</strong>
        </div>
      </div>
      <section className="card" aria-label="Needs attention">
        <h2>Needs attention</h2>
        {attention === 0 ? (
          <p className="muted">Nothing needs you right now.</p>
        ) : null}
        {ready.map((op) => (
          <div className="dash-item" key={op.operationId}>
            <div>
              <b>{op.host}</b> <code>{displayArgv(op.argv)}</code>
              <p className="muted">{labelOf(op)}</p>
            </div>
            <button
              type="button"
              className="accept"
              data-action="control-execute"
              data-id={op.operationId}
            >
              Accept
            </button>
            <button
              type="button"
              className="danger"
              data-action="control-deny"
              data-id={op.operationId}
            >
              Deny
            </button>
          </div>
        ))}
        {awaiting.map((op) => (
          <div className="dash-item" key={op.operationId}>
            <div>
              <b>{op.host}</b> <code>{displayArgv(op.argv)}</code>
              <p className="muted">Waiting for approval by another client</p>
            </div>
            <button
              type="button"
              className="danger"
              data-action="control-deny"
              data-id={op.operationId}
            >
              Deny
            </button>
          </div>
        ))}
        {pairing.map((request) => (
          <div className="dash-item" key={request.id}>
            <div>
              <b>Pairing request from {request.remoteName}</b>
              <p className="muted">Compare the phrase on both screens in Sync.</p>
            </div>
            <a className="button-link" href="#sync" data-view="sync">
              Open Sync
            </a>
          </div>
        ))}
      </section>
    </section>
  );
}
