// Operations waiting on linked clients, across all of them. Each row shows what
// will run, the risk, the fingerprint the decision is bound to, and the agent's
// narrative as untrusted text. A step-up operation gets no approve button: the
// owner approves it on its own device. The row also shows the newest decision
// the server queued for it: while that is queued or delivered the buttons are
// disabled, and a refused decision shows its reason and can be decided again.
import { untrustedText } from "./api";
import { UNDER_REVIEW_NOTE, isUnderReview } from "./review";
import {
  decisionKey,
  decisionOffer,
  intentState,
  type WorkspaceClient,
  type WorkspaceDecision,
  type WorkspacePending,
} from "./workspace-api";
import { Argv, Badge, fmtTime, Notice, Untrusted } from "./ui";

export function PendingSection({
  pending,
  clients,
  busy,
  onDecide,
}: {
  pending: WorkspacePending[];
  clients: WorkspaceClient[];
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
  busy,
  onDecide,
}: {
  operation: WorkspacePending;
  client: WorkspaceClient | undefined;
  busy: boolean;
  onDecide: (
    operation: WorkspacePending,
    decision: WorkspaceDecision,
  ) => Promise<unknown>;
}) {
  const offer = decisionOffer(operation, client);
  const risky = operation.risk === "R3" || operation.risk === "R4";
  const state = intentState(operation.intent);
  // A queued or delivered decision blocks new ones; an applied one ends the item.
  const locked = state?.blocks === true;
  const done = state?.applied === true;
  const underReview = isUnderReview(operation.source);
  return (
    <article
      className="item"
      aria-label={`Approval from ${operation.originName}`}
    >
      <div className="row between">
        <strong>
          Command on <span className="mono">{operation.host}</span>
        </strong>
        <div className="row">
          {underReview ? <Badge tone="warn">Under review</Badge> : null}
          <Badge tone={risky ? "bad" : "warn"}>Risk {operation.risk}</Badge>
        </div>
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
      {underReview ? <p className="small">{UNDER_REVIEW_NOTE}</p> : null}
      <div className="small mono">Fingerprint {operation.fingerprint}</div>
      <Untrusted
        text={untrustedText(operation.narrative)}
        label="Agent's explanation"
      />
      {operation.narrative ? null : (
        <p className="small muted">The agent gave no explanation.</p>
      )}
      {state ? <Notice tone={state.tone}>{state.text}</Notice> : null}
      {offer.note ? <p className="small muted">{offer.note}</p> : null}
      {!done && (offer.approve || offer.deny) ? (
        <div className="row">
          {offer.approve ? (
            <button
              type="button"
              className="primary"
              disabled={busy || locked}
              onClick={() => void onDecide(operation, "approve-once")}
            >
              Approve once
            </button>
          ) : null}
          {offer.deny ? (
            <button
              type="button"
              className="danger"
              disabled={busy || locked}
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
