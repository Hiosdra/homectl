// Central secret form for linked workspace clients (homelab #21 S1-S2, D8).
// Shows each linked client's pending secret request with its exact destination
// and untrusted purpose. Values live only in React state while typing, are
// cleared immediately on submit, and are never persisted on the server.
import { useId, useState } from "react";
import { describeError, untrustedText } from "./api";
import { Icon } from "./icons";
import { displayName } from "./plain-words";
import { RadioRow } from "./radio";
import { DestinationBlock, inputFor } from "./secret";
import { expiresIn } from "./time";
import { Badge, Field, Notice, PasswordStep, Untrusted } from "./ui";
import {
  declineWorkspaceSecret,
  decisionKey,
  provideWorkspaceSecret,
  secretIntentState,
  type WorkspaceClient,
  type WorkspacePendingSecret,
} from "./workspace-api";

export function WorkspaceSecretsSection({
  secrets,
  clients,
  onChanged,
  onError,
}: {
  secrets: WorkspacePendingSecret[];
  clients: WorkspaceClient[];
  onChanged: () => Promise<void>;
  onError: (error: unknown) => unknown;
}) {
  if (secrets.length === 0) return null;
  const byId = new Map(clients.map((client) => [client.id, client]));
  const sorted = [...secrets].sort(
    (a, b) => a.requestExpiresAt - b.requestExpiresAt,
  );
  return (
    <div className="group" aria-labelledby="workspace-secrets-heading">
      <h3 id="workspace-secrets-heading" className="group-title">
        Secret requests <Badge tone="count">{secrets.length}</Badge>
      </h3>
      <div className="request-list">
        {sorted.map((request) => (
          <WorkspaceSecretCard
            key={decisionKey(request.origin, request.id)}
            request={request}
            client={byId.get(request.origin)}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}

function WorkspaceSecretCard({
  request,
  client,
  onChanged,
  onError,
}: {
  request: WorkspacePendingSecret;
  client: WorkspaceClient | undefined;
  onChanged: () => Promise<void>;
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(request.fields.map((field) => [field.name, ""])),
  );
  const [retention, setRetention] = useState<"ephemeral" | "saved">(
    "ephemeral",
  );
  const [saveName, setSaveName] = useState("");
  const [reuse, setReuse] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const state = secretIntentState(request.intent);
  const locked = state?.blocks === true;
  const done = state?.applied === true;
  const canRemote = client?.remoteApproval === true;
  const canProvide = canRemote && !request.admin && !locked && !done;
  const canReuse =
    retention === "saved" &&
    request.canSave &&
    !request.admin &&
    request.destination.kind !== "vault-only" &&
    !request.fields.some((field) => field.kind === "ssh-key");
  const allFilled = request.fields.every(
    (field) => (values[field.name] ?? "").length > 0,
  );

  async function provide(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (busy || !canProvide || !allFilled || !password) return;
    if (retention === "saved" && !saveName.trim()) {
      setError("Enter a name to save this secret in the vault.");
      return;
    }
    setBusy(true);
    setError(undefined);
    const snapshot = { ...values };
    const pw = password;
    setValues(
      Object.fromEntries(request.fields.map((field) => [field.name, ""])),
    );
    setPassword("");
    try {
      await provideWorkspaceSecret({
        client: request.origin,
        id: request.id,
        values: snapshot,
        retention,
        ...(retention === "saved"
          ? { saveName: saveName.trim(), reuse: canReuse && reuse }
          : {}),
        password: pw,
      });
      await onChanged();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (busy || !canRemote || locked || done) return;
    setBusy(true);
    setError(undefined);
    try {
      await declineWorkspaceSecret({
        client: request.origin,
        id: request.id,
      });
      await onChanged();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className="item request-card"
      data-risk="big"
      aria-label={`Secret request from ${request.originName}`}
    >
      <div className="request-head">
        <span className="assistant-tag">
          <Icon name="bot" />
          {displayName(request.client)}
        </span>
        <Badge tone="warn">Secret requested</Badge>
      </div>
      <DestinationBlock destination={request.destination} />
      <p className="request-meta">
        From {request.originName} · {expiresIn(request.requestExpiresAt)}
      </p>
      <Untrusted
        text={untrustedText(request.purpose)}
        label="Assistant's reason"
      />
      {state ? <Notice tone={state.tone}>{state.text}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {!canRemote ? (
        <p className="small muted">
          This client does not accept responses from this server. Respond on its
          own device.
        </p>
      ) : request.admin ? (
        <p className="small muted">
          This secret requires admin elevation. Provide it on its own device;
          you can still decline it here.
        </p>
      ) : null}
      {!done && canRemote ? (
        <form className="stack" onSubmit={(event) => void provide(event)}>
          {!request.admin && !locked ? (
            <>
              {request.fields.map((field) => {
                const id = `${baseId}-${field.name}`;
                return (
                  <Field
                    key={field.name}
                    label={field.label ?? field.name}
                    id={id}
                  >
                    {inputFor(
                      field,
                      values[field.name] ?? "",
                      (next) =>
                        setValues((prev) => ({ ...prev, [field.name]: next })),
                      id,
                    )}
                  </Field>
                );
              })}
              <div className="stack">
                <RadioRow
                  name={`${baseId}-retention`}
                  value="ephemeral"
                  checked={retention === "ephemeral"}
                  onChange={() => {
                    setRetention("ephemeral");
                    setReuse(false);
                  }}
                  title="Use once for up to 1 hour"
                  detail="Kept in memory on the linked device only; never saved to disk."
                />
                {request.canSave ? (
                  <RadioRow
                    name={`${baseId}-retention`}
                    value="saved"
                    checked={retention === "saved"}
                    onChange={() => setRetention("saved")}
                    title="Save to the linked device's vault"
                    detail="Stored encrypted in that device's vault when unlocked."
                  />
                ) : null}
              </div>
              {retention === "saved" ? (
                <>
                  <Field label="Vault entry name" id={`${baseId}-save`}>
                    <input
                      id={`${baseId}-save`}
                      type="text"
                      value={saveName}
                      required
                      onChange={(event) => setSaveName(event.target.value)}
                    />
                  </Field>
                  {canReuse ? (
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={reuse}
                        onChange={(event) => setReuse(event.target.checked)}
                      />
                      <span>
                        Reuse automatically for this same assistant, destination
                        and fields
                      </span>
                    </label>
                  ) : null}
                </>
              ) : null}
              <PasswordStep
                value={password}
                onChange={setPassword}
                hint="Confirm your owner password on this server to send this secret."
              />
            </>
          ) : null}
          <div className="request-actions">
            {!request.admin ? (
              <button
                type="submit"
                className="primary"
                disabled={busy || !canProvide || !allFilled || !password}
              >
                {busy ? "Sending…" : "Provide secret"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy || locked}
              onClick={() => void decline()}
            >
              Decline
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}
