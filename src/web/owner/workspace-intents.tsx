// The newest decisions the owner sent from this server, across linked clients, each
// with its status in one word. A refusal's reason comes from the client and is shown as
// plain text. The decision and operation ids sit under Details.
import type { WorkspaceClient, WorkspaceIntentRow } from "./workspace-api";
import { Badge, type Tone } from "./ui";

const STATUS: Record<
  WorkspaceIntentRow["status"],
  { word: string; tone: Tone }
> = {
  queued: { word: "Queued", tone: "warn" },
  delivered: { word: "Delivered", tone: "info" },
  applied: { word: "Applied", tone: "good" },
  refused: { word: "Refused", tone: "bad" },
};

export function IntentHistory({
  intents,
  clients,
}: {
  intents: WorkspaceIntentRow[];
  clients: WorkspaceClient[];
}) {
  if (intents.length === 0) return null;
  const names = new Map(clients.map((client) => [client.id, client.name]));
  return (
    <section aria-labelledby="intents-heading">
      <h3 id="intents-heading">
        Recent decisions <Badge tone="count">{intents.length}</Badge>
      </h3>
      <ul className="plain-list-bare" aria-label="Recent decisions">
        {intents.map((row) => {
          const status = STATUS[row.status];
          const from = names.get(row.client) ?? row.client;
          return (
            <li key={row.id} className="intent-row">
              <div className="row between">
                <span>
                  <strong>
                    {row.decision === "approve-once" ? "Approved" : "Denied"}
                  </strong>{" "}
                  a request from {from}
                </span>
                <Badge tone={status.tone}>{status.word}</Badge>
              </div>
              {row.reason ? <p className="small">{row.reason}</p> : null}
              <details className="why">
                <summary>Details</summary>
                <dl>
                  <dt>Operation</dt>
                  <dd className="mono">{row.operationId}</dd>
                  <dt>Decision</dt>
                  <dd className="mono">{row.id}</dd>
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
