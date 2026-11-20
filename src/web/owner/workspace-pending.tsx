// Operations waiting on linked clients, across all of them. Each card says what the
// assistant wants in one plain sentence, names the linked device it came from, and
// shows the exact command. The broker's reason, the fingerprint the decision is bound
// to and the risk code sit under Details. The assistant's narrative is untrusted text.
// A step-up operation gets no approve button: the owner approves it on its own device.
// The card also shows the newest decision the server queued for it: while that is
// queued or delivered the buttons are disabled, and a refused decision shows its
// reason and can be decided again.
import { untrustedText } from "./api";
import { Icon } from "./icons";
import { riskView } from "./risk";
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
import { displayName, plainAction, whyWaits } from "./plain-words";
import { expiresIn } from "./time";

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
    <div className="group" aria-labelledby="pending-heading">
      <h3 id="pending-heading" className="group-title">
        Waiting for you <Badge tone="count">{pending.length}</Badge>
      </h3>
      {sorted.length === 0 ? (
        <p className="muted">
          Nothing is waiting on a linked client. This list updates as clients
          sync.
        </p>
      ) : null}
      <div className="request-list">
        {sorted.map((operation) => (
          <PendingItem
            key={decisionKey(operation.origin, operation.id)}
            operation={operation}
            client={byId.get(operation.origin)}
            busy={busy}
            onDecide={onDecide}
          />
        ))}
      </div>
    </div>
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
  const risk = riskView(operation.risk);
  const state = intentState(operation.intent);
  // A queued or delivered decision blocks new ones; an applied one ends the item.
  const locked = state?.blocks === true;
  const done = state?.applied === true;
  const underReview = isUnderReview(operation.source);
  return (
    <article
      className="item request-card"
      data-risk={risk.stripe}
      aria-label={`Approval from ${operation.originName}`}
    >
      <div className="request-head">
        <span className="assistant-tag">
          <Icon name="bot" />
          {displayName(operation.client)}
        </span>
        <div className="row">
          {underReview ? <Badge tone="warn">Under review</Badge> : null}
          <Badge tone={risk.tone} icon={risk.icon}>
            {risk.label}
          </Badge>
        </div>
      </div>
      <p className="lead">{`Wants to ${plainAction(operation.argv)} on ${operation.host}.`}</p>
      <Argv argv={operation.argv} />
      <p className="small">
        {whyWaits({
          stripe: risk.stripe,
          stepUp: operation.stepUp,
          humanOnly: operation.humanOnly,
          underReview,
        })}
      </p>
      <p className="request-meta">
        From {operation.originName} · {expiresIn(operation.expiresAt)}
      </p>
      {underReview ? <p className="small">{UNDER_REVIEW_NOTE}</p> : null}
      <Untrusted
        text={untrustedText(operation.narrative)}
        label="Assistant's explanation"
      />
      {operation.narrative ? null : (
        <p className="small muted">The assistant gave no explanation.</p>
      )}
      <details className="details">
        <summary>Details</summary>
        <dl>
          <dt>Machine</dt>
          <dd className="mono">{operation.host}</dd>
          <dt>Risk level</dt>
          <dd className="mono">{operation.risk}</dd>
          <dt>Broker reason</dt>
          <dd>
            {operation.reason}
            {operation.stepUp ? " · needs step-up" : ""}
            {operation.humanOnly ? " · human only" : ""}
          </dd>
          <dt>Fingerprint</dt>
          <dd className="mono">{operation.fingerprint}</dd>
          <dt>Assistant id</dt>
          <dd className="mono">{operation.client}</dd>
          <dt>Expires</dt>
          <dd>{fmtTime(operation.expiresAt)}</dd>
        </dl>
      </details>
      {state ? <Notice tone={state.tone}>{state.text}</Notice> : null}
      {offer.note ? <p className="small muted">{offer.note}</p> : null}
      {!done && (offer.approve || offer.deny) ? (
        <div className="request-actions">
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
