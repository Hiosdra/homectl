// One pending secret request card in "Needs you".
import { useState } from "react";
import { describeError, type PendingSecret, ownerCall } from "./api";
import type { AssistantNames } from "./assistant-names";
import { Icon } from "./icons";
import { displayName } from "./plain-words";
import { relativeTime, toEpoch, waitingUntil } from "./time";
import { Badge, Notice } from "./ui";

export function describeDestination(request: PendingSecret): string {
  const destination = request.destination;
  switch (destination.kind) {
    case "ssh-stdin":
      return destination.host;
    case "target-file":
      return `${destination.host}:${destination.path}`;
    case "http-header":
      return destination.url;
    case "vault-only":
      return "the vault only";
  }
}

export function SecretCard({
  request,
  names,
  onOpen,
  onDone,
  onError,
}: {
  request: PendingSecret;
  names: AssistantNames;
  onOpen: (hash: string) => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const expires = toEpoch(request.expiresAt);
  const asked = toEpoch(request.createdAt);
  const decline = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await ownerCall("/v1/owner/secrets/decline", { id: request.id });
      onDone("Declined. The assistant was told.");
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const count = request.fields.length;
  const meta = [
    asked !== undefined ? `Asked ${relativeTime(asked)}` : undefined,
    expires !== undefined ? waitingUntil(expires) : undefined,
  ].filter((part): part is string => part !== undefined);
  return (
    <div className="item request-card" data-risk="look">
      <div className="request-head">
        <span className="assistant-tag">
          <Icon name="bot" />
          {displayName(request.client, names)}
        </span>
        <Badge tone="info" icon="key">
          Secret request
        </Badge>
      </div>
      <p className="lead">
        {`Needs ${count === 1 ? "a value" : `${count} values`} for ${describeDestination(request)}.`}
      </p>
      <p className="small muted">
        It is typed here, is never shown again, and is not sent unless you
        provide it.
      </p>
      {meta.length > 0 ? (
        <p className="request-meta">{meta.join(" · ")}</p>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="request-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onOpen(`#/secrets/${encodeURIComponent(request.id)}`)}
        >
          Provide…
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
