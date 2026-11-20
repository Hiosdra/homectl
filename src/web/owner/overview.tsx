// "Needs you": everything that waits for the owner, most urgent first. Each card
// shows the exact command and what it is in plain words. Small, undoable requests
// can be approved from the list in one tap; anything that needs the owner password
// (and every big or destructive change) opens its detail screen first. Requester
// text is never shown here; the detail screens show it, labelled as untrusted.
import { useEffect, useState } from "react";
import {
  describeError,
  type DecideResult,
  type PendingOperation,
  type PendingSecret,
  ownerCall,
} from "./api";
import { type ViewScope } from "./context";
import { ContextNote } from "./context-switcher";
import { DECISION_NOTICE, OUTCOME, type ApprovalDecision } from "./approval";
import { Icon } from "./icons";
import { canApproveFromList, riskView } from "./risk";
import { isUnderReview } from "./review";
import { expiresIn, relativeTime, toEpoch } from "./time";
import { Badge, Notice } from "./ui";

export function OverviewScreen({
  data,
  workspaceWaiting = 0,
  scope,
  onOpen,
  onQuickDone,
  onError,
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
  // A one-tap decision: the message names the result, the list refreshes.
  onQuickDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  // Re-render every half minute so "in 12 minutes" stays true while open.
  const [, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const total = data.operations.length + data.secrets.length + workspaceWaiting;
  return (
    <>
      <div className="page-head">
        <h2>Needs you</h2>
        <p>
          {total === 0
            ? "Nothing is waiting. Assistants keep working within their permissions."
            : `${total} ${total === 1 ? "thing needs" : "things need"} you. Small changes can be approved here; anything bigger opens with its exact command shown.`}
        </p>
      </div>
      <ContextNote scope={scope} />

      {total === 0 ? (
        <section className="empty" aria-label="All caught up">
          <div className="empty-mark">
            <Icon name="check-circle" />
          </div>
          <h3>You are all caught up</h3>
          <p>
            No approvals or secret requests are waiting. Assistants keep working
            within their permissions. This page updates live.
          </p>
          <div className="row">
            <button type="button" onClick={() => onOpen("#/agents")}>
              <Icon name="bot" />
              See your assistants
            </button>
          </div>
        </section>
      ) : null}

      {workspaceWaiting > 0 ? (
        <section aria-labelledby="workspace-waiting-heading">
          <div className="row between">
            <h3 id="workspace-waiting-heading">
              Linked devices <Badge tone="count">{workspaceWaiting}</Badge>
            </h3>
          </div>
          <div className="item">
            <p>
              {workspaceWaiting === 1
                ? "One approval is"
                : `${workspaceWaiting} approvals are`}{" "}
              waiting on a linked client. Each one is decided on that device.
            </p>
            <div>
              <button
                type="button"
                className="primary"
                onClick={() => onOpen("#/workspace")}
              >
                Review in Devices &amp; backup
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
            <ApprovalCard
              key={op.id}
              operation={op}
              onOpen={onOpen}
              onDone={onQuickDone}
              onError={onError}
            />
          ))}
        </section>
      ) : null}

      {data.secrets.length > 0 ? (
        <section aria-labelledby="secrets-heading">
          <h3 id="secrets-heading">
            Secret requests <Badge tone="count">{data.secrets.length}</Badge>
          </h3>
          {data.secrets.map((request) => (
            <SecretCard
              key={request.id}
              request={request}
              onOpen={onOpen}
              onDone={onQuickDone}
              onError={onError}
            />
          ))}
        </section>
      ) : null}

      <p className="small muted">
        {data.loadedAt
          ? `Last checked ${relativeTime(data.loadedAt)}.`
          : "Checking the broker…"}
      </p>
    </>
  );
}

function ApprovalCard({
  operation: op,
  onOpen,
  onDone,
  onError,
}: {
  operation: PendingOperation;
  onOpen: (hash: string) => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const risk = riskView(op.risk);
  const expires = toEpoch(op.expiresAt);
  const asked = toEpoch(op.createdAt);
  const quick = canApproveFromList(op);

  // Approve or deny without the password step. Remembering a rule is never
  // offered here: that stays on the detail screen.
  const decide = async (
    kind: Extract<ApprovalDecision, "approve-once" | "deny-once">,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await ownerCall<DecideResult>("/v1/owner/decide", {
        operationId: op.id,
        fingerprint: op.fingerprint,
        decision: kind,
      });
      onDone(OUTCOME[result.operation.state] ?? DECISION_NOTICE[kind]);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="item request" data-risk={risk.stripe}>
      <div className="request-head">
        <Badge tone={risk.tone} icon={risk.icon}>
          {risk.label}
        </Badge>
        <span className="request-meta">
          {asked !== undefined ? `Asked ${relativeTime(asked)}` : ""}
        </span>
      </div>
      <p className="lead">
        <span className="command">{op.argv.join(" ")}</span> on{" "}
        <span className="mono">{op.host}</span>
      </p>
      <p className="small muted">
        From {op.client} · {op.decision.reason}
        {isUnderReview(op.decision.source) ? " · Under review" : ""}
      </p>
      {expires !== undefined ? (
        <p className="small muted">{expiresIn(expires)}</p>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="request-actions">
        {quick ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void decide("approve-once")}
            >
              Approve
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void decide("deny-once")}
            >
              Deny
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => onOpen(`#/approvals/${encodeURIComponent(op.id)}`)}
            >
              Review
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => onOpen(`#/approvals/${encodeURIComponent(op.id)}`)}
            >
              Review
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void decide("deny-once")}
            >
              Deny
            </button>
          </>
        )}
      </div>
      {!quick ? (
        <p className="small muted">
          Approving this needs your owner password. You will see the exact
          command first.
        </p>
      ) : null}
    </div>
  );
}

function SecretCard({
  request,
  onOpen,
  onDone,
  onError,
}: {
  request: PendingSecret;
  onOpen: (hash: string) => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const expires = toEpoch(request.expiresAt);
  const decline = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await ownerCall("/v1/owner/secrets/decline", { id: request.id });
      onDone("Declined. The agent was told.");
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="item request">
      <div className="request-head">
        <Badge tone="info" icon="key">
          Secret request
        </Badge>
        <span className="request-meta">From {request.client}</span>
      </div>
      <p className="lead">
        {request.fields.length} field
        {request.fields.length === 1 ? "" : "s"} for{" "}
        {describeDestination(request)}
      </p>
      <p className="small muted">
        The value is typed here and never shown again. It is not sent unless you
        provide it.
        {expires !== undefined ? ` ${expiresIn(expires)}.` : ""}
      </p>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="request-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onOpen(`#/secrets/${encodeURIComponent(request.id)}`)}
        >
          Provide or decline
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void decline()}
        >
          Decline
        </button>
      </div>
    </div>
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
