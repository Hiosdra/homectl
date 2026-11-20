// The newest decisions the owner sent from this server, across linked clients,
// with their status. Compact on purpose: one line per decision. Refusal reasons
// come from the client and are shown as plain text.
import type { WorkspaceClient, WorkspaceIntentRow } from "./workspace-api";
import { Badge } from "./ui";

const STATUS_WORD: Record<WorkspaceIntentRow["status"], string> = {
  queued: "queued",
  delivered: "delivered",
  applied: "applied",
  refused: "refused",
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
      <ul aria-label="Recent decisions">
        {intents.map((row) => (
          <li key={row.id} className="small">
            {row.decision === "approve-once" ? "Approval" : "Denial"} for{" "}
            <span className="mono">{row.operationId}</span> on{" "}
            {names.get(row.client) ?? row.client}: {STATUS_WORD[row.status]}
            {row.reason ? ` (${row.reason})` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
