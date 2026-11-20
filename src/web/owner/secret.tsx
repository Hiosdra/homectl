// Provide or decline one secret request. The destination is shown exactly, so
// the owner knows where the value will go. Values live only in this form's
// state: they are never logged, never put in the URL or storage, and cleared as
// soon as the request is sent.
import { useId, useState } from "react";
import {
  describeError,
  type PendingSecret,
  type SecretField,
  ownerCall,
  untrustedText,
} from "./api";
import { Argv, Badge, Field, Notice, PasswordStep, Untrusted } from "./ui";

type Retention = "ephemeral" | "saved";

// Field kinds decide how the value is typed and masked.
export function inputFor(
  field: SecretField,
  value: string,
  onChange: (value: string) => void,
  id: string,
) {
  const common = {
    id,
    value,
    required: true,
    autoComplete: "off",
    spellCheck: false,
    autoCapitalize: "off",
    onChange: (event: { target: { value: string } }) =>
      onChange(event.target.value),
  } as const;
  switch (field.kind) {
    case "ssh-key":
      return (
        <textarea
          {...common}
          className="masked"
          rows={6}
          aria-describedby={`${id}-hint`}
        />
      );
    case "password":
    case "token":
      return <input {...common} type="password" />;
    case "text":
      return <input {...common} type="text" />;
  }
}

export function DestinationBlock({ request }: { request: PendingSecret }) {
  const destination = request.destination;
  switch (destination.kind) {
    case "ssh-stdin":
      return (
        <dl>
          <dt>Goes to</dt>
          <dd>stdin of a command on {destination.host}</dd>
          <dt>Command</dt>
          <dd>
            <Argv argv={destination.argv} />
          </dd>
        </dl>
      );
    case "http-header":
      return (
        <dl>
          <dt>Goes to</dt>
          <dd>
            HTTPS request header <code>{destination.header}</code> at{" "}
            <code>{destination.url}</code>
          </dd>
        </dl>
      );
    case "target-file":
      return (
        <dl>
          <dt>Goes to</dt>
          <dd>
            File <code>{destination.path}</code> on {destination.host}, mode{" "}
            <code>{destination.mode}</code>
          </dd>
        </dl>
      );
    case "vault-only":
      return (
        <p className="small">
          Kept in the vault only. Nothing is sent to a host yet.
        </p>
      );
  }
}

export function SecretScreen({
  request,
  onDone,
  onError,
}: {
  request: PendingSecret;
  onDone: (message: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [retention, setRetention] = useState<Retention>("ephemeral");
  const [saveName, setSaveName] = useState("");
  // Providing a value is a step-up: the owner password goes with the request.
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const complete =
    request.fields.every((field) => (values[field.name] ?? "").length > 0) &&
    (retention === "ephemeral" || saveName.trim().length > 0) &&
    password.length > 0;

  const provide = async () => {
    if (busy || !complete) return;
    // Copy out, then clear the form before the request leaves.
    const payload = { ...values };
    const secret = password;
    setValues({});
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      await ownerCall("/v1/owner/secrets/provide", {
        id: request.id,
        values: payload,
        retention,
        password: secret,
        ...(retention === "saved" ? { saveName: saveName.trim() } : {}),
      });
      setSaveName("");
      onDone(
        retention === "saved"
          ? "Saved to the vault. The agent can now use it for this destination."
          : "Provided for one hour in memory. It is dropped afterwards.",
      );
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setValues({});
    setBusy(true);
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
    <article className="stack" aria-labelledby="secret-title">
      <section>
        <div className="row between">
          <h2 id="secret-title">Secret request</h2>
          <Badge>{request.client}</Badge>
        </div>
        <Untrusted
          label="Why the agent asks"
          text={untrustedText(request.purpose)}
        />
        <h3>Where the value goes</h3>
        <DestinationBlock request={request} />
      </section>

      <section className="stack" aria-label="Values">
        {request.fields.map((field) => {
          const id = `${baseId}-${field.name}`;
          return (
            <Field
              key={field.name}
              id={id}
              label={field.label}
              hint={
                field.kind === "ssh-key"
                  ? "masked; paste the whole key"
                  : field.kind === "text"
                    ? undefined
                    : "hidden as you type"
              }
            >
              {inputFor(
                field,
                values[field.name] ?? "",
                (value) =>
                  setValues((current) => ({ ...current, [field.name]: value })),
                id,
              )}
            </Field>
          );
        })}

        <fieldset>
          <legend>How long to keep it</legend>
          <label>
            <input
              type="radio"
              name="retention"
              checked={retention === "ephemeral"}
              onChange={() => setRetention("ephemeral")}
            />{" "}
            One hour in memory only (default). Then it is dropped.
          </label>
          <label>
            <input
              type="radio"
              name="retention"
              checked={retention === "saved"}
              onChange={() => setRetention("saved")}
            />{" "}
            Save to the encrypted vault
          </label>
          {retention === "saved" ? (
            <Field id={`${baseId}-save`} label="Vault name">
              <input
                id={`${baseId}-save`}
                type="text"
                autoComplete="off"
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
              />
            </Field>
          ) : null}
        </fieldset>

        <PasswordStep
          value={password}
          onChange={setPassword}
          hint="required to provide"
        />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={busy || !complete}
            onClick={provide}
          >
            Provide secret
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={decline}
          >
            Decline
          </button>
        </div>
        <p className="small muted">
          Values are sent once to your homectl broker and are never shown again.
        </p>
      </section>
    </article>
  );
}
