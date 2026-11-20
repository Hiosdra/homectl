// Operations waiting on linked clients, across all of them. Each row shows what
// will run, the risk, the fingerprint the decision is bound to, and the agent's
// narrative as untrusted text. A step-up operation gets no approve button: the
// owner approves it on its own device.
import { untrustedText } from "./api";
import {
  decisionKey,
  decisionOffer,
  type WorkspaceClient,
  type WorkspaceDecision,
  type WorkspaceIntent,
  type WorkspacePending,
} from "./workspace-api";
import { Argv, Badge, fmtTime, Notice, Untrusted } from "./ui";

export function PendingSection({
  pending,
  clients,
  intents,
  busy,
  onDecide,
}: {
  pending: WorkspacePending[];
  clients: WorkspaceClient[];
  intents: Record<string, WorkspaceIntent>;
  busy: boolean;
  onDecide: (
    operation: WorkspacePending,
    decision: WorkspaceDecision,
  ) => Promise<unknown>;
}) {
  const byId = new Map(clients.map((client) => [client.id, client]));
  const sorted = [...pending].sort((a, b) => a.expiresAt - b.expiresAt);
  return (
    <section aria-labelledby="pending-heading">
      <h3 id="pending-heading">
        Waiting for you <Badge tone="count">{pending.length}</Badge>
      </h3>
      {sorted.length === 0 ? (
        <p className="muted">
          Nothing is waiting on a linked client. This list updates as clients
          sync.
        </p>
      ) : null}
      {sorted.map((operation) => (
        <PendingItem
          key={decisionKey(operation.origin, operation.id)}
          operation={operation}
          client={byId.get(operation.origin)}
          intent={intents[decisionKey(operation.origin, operation.id)]}
          busy={busy}
          onDecide={onDecide}
        />
      ))}
    </section>
  );
}

function PendingItem({
  operation,
  client,
  intent,
  busy,
  onDecide,
}: {
  operation: WorkspacePending;
  client: WorkspaceClient | undefined;
  intent: WorkspaceIntent | undefined;
  busy: boolean;
  onDecide: (
    operation: WorkspacePending,
    decision: WorkspaceDecision,
  ) => Promise<unknown>;
}) {
  const offer = decisionOffer(operation, client);
  const risky = operation.risk === "R3" || operation.risk === "R4";
  // A decision already on its way blocks a second one on this server.
  const decided = intent !== undefined;
  return (
    <article
      className="item"
      aria-label={`Approval from ${operation.originName}`}
    >
      <div className="row between">
        <strong>
          Command on <span className="mono">{operation.host}</span>
        </strong>
        <Badge tone={risky ? "bad" : "warn"}>Risk {operation.risk}</Badge>
      </div>
      <div className="small muted">
        From {operation.originName} · agent {operation.client} · expires{" "}
        {fmtTime(operation.expiresAt)}
      </div>
      <Argv argv={operation.argv} />
      <div className="small">
        Policy says: {operation.reason}
        {operation.stepUp ? " · needs step-up" : ""}
        {operation.humanOnly ? " · human only" : ""}
      </div>
      <div className="small mono">Fingerprint {operation.fingerprint}</div>
      <Untrusted
        text={untrustedText(operation.narrative)}
        label="Agent's explanation"
      />
      {operation.narrative ? null : (
        <p className="small muted">The agent gave no explanation.</p>
      )}
      {intent ? (
        <Notice>
          {intent.decision === "approve-once" ? "Approval" : "Denial"} sent to
          the client. It applies the decision at its next sync. This page cannot
          show later progress yet.
        </Notice>
      ) : null}
      {offer.note ? <p className="small muted">{offer.note}</p> : null}
      {!decided && (offer.approve || offer.deny) ? (
        <div className="row">
          {offer.approve ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void onDecide(operation, "approve-once")}
            >
              Approve once
            </button>
          ) : null}
          {offer.deny ? (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void onDecide(operation, "deny-once")}
            >
              Deny once
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
