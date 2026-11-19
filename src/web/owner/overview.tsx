// Attention first: approvals and secret requests that wait for the owner, then
// a quiet status line. Requester text is not shown here; the detail screens
// show it, labelled as untrusted.
import { type PendingOperation, type PendingSecret } from "./api";
import { Badge, fmtTime, Notice } from "./ui";

export function OverviewScreen({
  data,
  onOpen,
}: {
  data: {
    operations: PendingOperation[];
    secrets: PendingSecret[];
    loadedAt: number;
  };
  onOpen: (hash: string) => void;
}) {
  const total = data.operations.length + data.secrets.length;
  return (
    <>
      <h2>{total === 0 ? "Nothing needs you" : "Needs you"}</h2>
      {total === 0 ? (
        <Notice tone="good">
          No approvals or secret requests are waiting. Agents keep working
          within their permissions; this page updates live.
        </Notice>
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
                <Badge tone={op.risk === "R3" || op.risk === "R4" ? "bad" : "warn"}>
                  {op.risk}
                </Badge>
              </div>
              <div className="small muted">
                From {op.client} · {op.classification} · {op.decision.reason}
              </div>
              <div className="small muted">Expires {fmtTime(op.expiresAt)}</div>
              <div>
                <button
                  type="button"
                  className="primary"
                  onClick={() => onOpen(`#/approvals/${encodeURIComponent(op.id)}`)}
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
              <div className="small muted">Expires {fmtTime(request.expiresAt)}</div>
              <div>
                <button
                  type="button"
                  className="primary"
                  onClick={() => onOpen(`#/secrets/${encodeURIComponent(request.id)}`)}
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
