// Attention first: approvals and secret requests that wait for the owner, then
// a quiet status line. Requester text is not shown here; the detail screens
// show it, labelled as untrusted.
import { type PendingOperation, type PendingSecret } from "./api";
import { type ViewScope } from "./context";
import { ContextNote } from "./context-switcher";
import { isUnderReview } from "./review";
import { Badge, fmtTime, Notice } from "./ui";

export function OverviewScreen({
  data,
  workspaceWaiting = 0,
  scope,
  onOpen,
}: {
  data: {
    operations: PendingOperation[];
    secrets: PendingSecret[];
    loadedAt: number;
  };
  // Approvals waiting on linked clients (workspace server only).
  workspaceWaiting?: number;
  // The device context this inbox shows; the note names it.
  scope?: ViewScope;
  onOpen: (hash: string) => void;
}) {
  const total = data.operations.length + data.secrets.length + workspaceWaiting;
  return (
    <>
      <h2>{total === 0 ? "Nothing needs you" : "Needs you"}</h2>
      <ContextNote scope={scope} />
      {total === 0 ? (
        <Notice tone="good">
          No approvals or secret requests are waiting. Agents keep working
          within their permissions; this page updates live.
        </Notice>
      ) : null}

      {workspaceWaiting > 0 ? (
        <section aria-labelledby="workspace-waiting-heading">
          <h3 id="workspace-waiting-heading">
            Linked clients <Badge tone="count">{workspaceWaiting}</Badge>
          </h3>
          <div className="item">
            <div>
              {workspaceWaiting === 1
                ? "One approval is"
                : `${workspaceWaiting} approvals are`}{" "}
              waiting on a linked client.
            </div>
            <div>
              <button
                type="button"
                className="primary"
                onClick={() => onOpen("#/workspace")}
              >
                Review in Workspace
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {data.operations.length > 0 ? (
        <section aria-labelledby="approvals-heading">
          <h3 id="approvals-heading">
            Approvals <Badge tone="count">{data.operations.length}</Badge>
          </h3>
          {data.operations.map((op) => (
            <div className="item" key={op.id}>
              <div className="row between">
                <strong>
                  {op.argv.join(" ")} on <span className="mono">{op.host}</span>
                </strong>
                <Badge
                  tone={op.risk === "R3" || op.risk === "R4" ? "bad" : "warn"}
                >
                  {op.risk}
                </Badge>
              </div>
              <div className="small muted">
                From {op.client} · {op.classification} · {op.decision.reason}
                {isUnderReview(op.decision.source) ? " · Under review" : ""}
              </div>
              <div className="small muted">Expires {fmtTime(op.expiresAt)}</div>
              <div>
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    onOpen(`#/approvals/${encodeURIComponent(op.id)}`)
                  }
                >
                  Review
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {data.secrets.length > 0 ? (
        <section aria-labelledby="secrets-heading">
          <h3 id="secrets-heading">
            Secret requests <Badge tone="count">{data.secrets.length}</Badge>
          </h3>
          {data.secrets.map((request) => (
            <div className="item" key={request.id}>
              <div className="row between">
                <strong>
                  {request.fields.length} field
                  {request.fields.length === 1 ? "" : "s"} for{" "}
                  {describeDestination(request)}
                </strong>
                <Badge>{request.client}</Badge>
              </div>
              <div className="small muted">
                Expires {fmtTime(request.expiresAt)}
              </div>
              <div>
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    onOpen(`#/secrets/${encodeURIComponent(request.id)}`)
                  }
                >
                  Provide or decline
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <p className="small muted">
        {data.loadedAt
          ? `Last checked ${fmtTime(data.loadedAt)}.`
          : "Checking the broker…"}
      </p>
    </>
  );
}

export function describeDestination(request: PendingSecret): string {
  const destination = request.destination;
  switch (destination.kind) {
    case "ssh-stdin":
      return `${destination.host}`;
    case "target-file":
      return `${destination.host}:${destination.path}`;
    case "http-header":
      return destination.url;
    case "vault-only":
      return "the vault only";
  }
}
