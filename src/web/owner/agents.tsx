// Agents (clients) that may call the broker. A token is shown once, when it is
// created or rotated; it is kept only in this component's state and dropped
// when the owner dismisses it or leaves the screen.
import { type FormEvent, useEffect, useId, useState } from "react";
import { type ClientView, describeError, ownerCall } from "./api";
import { relativeTime, toEpoch } from "./time";
import { Badge, Dialog, Field, Notice, PasswordStep, fmtTime } from "./ui";

interface Issued {
  client: ClientView;
  token: string;
}

export function setupCommand(kind: string, hosts: string[]): string {
  const list = hosts.length > 0 ? hosts.join(",") : "<host>";
  return `home-ctl agent connect ${kind} --hosts ${list}`;
}

export function AgentsScreen({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [clients, setClients] = useState<ClientView[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [issued, setIssued] = useState<Issued | undefined>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setClients(await ownerCall<ClientView[]>("/v1/owner/clients/list"));
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    }
  };

  useEffect(() => {
    void load();
    // The one-time token is dropped when the screen unmounts.
    return () => setIssued(undefined);
    // Loaded once per visit; the screen refreshes itself after each change.
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
      await load();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Assistants</h2>
        <p>
          An assistant is an AI tool, such as Claude or Codex, that asks homectl
          to run commands on your machines. Each one has its own token, machines
          and limits. Revoking one does not affect the others.
        </p>
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {issued ? (
        <TokenOnce issued={issued} onDismiss={() => setIssued(undefined)} />
      ) : null}

      <section aria-labelledby="agents-list">
        <h3 id="agents-list">Your assistants</h3>
        {clients === undefined ? <p className="muted">Loading…</p> : null}
        {clients?.length === 0 ? (
          <p className="muted">
            No assistants yet. Add one below to let Claude or Codex ask homectl
            for work on your machines.
          </p>
        ) : null}
        {clients?.map((client) => (
          <div className="item" key={client.id}>
            <div className="row between">
              <strong>{client.name}</strong>
              <Badge
                tone={client.revoked ? "bad" : "good"}
                icon={client.revoked ? "x" : "check"}
              >
                {client.revoked ? "Revoked" : "Active"}
              </Badge>
            </div>
            <div className="small muted">
              <span className="mono">{client.id}</span> · machines:{" "}
              {client.hosts.length > 0 ? client.hosts.join(", ") : "none"} ·
              limits: {client.scopes.join(", ") || "none"} · added{" "}
              <span title={fmtTime(client.createdAt)}>
                {toEpoch(client.createdAt) !== undefined
                  ? relativeTime(toEpoch(client.createdAt) as number)
                  : fmtTime(client.createdAt)}
              </span>
            </div>
            {!client.revoked ? (
              <RowActions
                client={client}
                busy={busy}
                onRotated={(result) => {
                  setIssued(result);
                }}
                onRun={run}
                onError={onError}
              />
            ) : null}
          </div>
        ))}
      </section>
      <CreateAgent
        onCreated={(result) => {
          setIssued(result);
          void load();
        }}
        onError={onError}
      />
    </>
  );
}

function TokenOnce({
  issued,
  onDismiss,
}: {
  issued: Issued;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<string | undefined>();
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`Copied the ${label}.`);
    } catch {
      setCopied("Select the text and copy it manually.");
    }
  };
  const setups = ["codex", "claude", "other"].map((kind) =>
    setupCommand(kind, issued.client.hosts),
  );
  return (
    <section aria-labelledby="token-title">
      <h3 id="token-title">Token for {issued.client.name}</h3>
      <Notice tone="warn">
        Shown once. Copy it now; it cannot be displayed again. Rotate the agent
        to get a new one.
      </Notice>
      <pre className="copy" aria-label="Agent token">
        {issued.token}
      </pre>
      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={() => copy("token", issued.token)}
        >
          Copy token
        </button>
        <button type="button" onClick={onDismiss}>
          I have copied it
        </button>
      </div>
      {copied ? (
        <p className="small muted" role="status">
          {copied}
        </p>
      ) : null}
      <h3>Connect the agent</h3>
      <p className="small">
        Use one of these two ways, not both. Each creates its own token.
      </p>
      <ol className="small">
        <li>
          Give the token above to the agent through its environment, as{" "}
          <code>HOMECTL_TOKEN</code>. Never paste it into chat.
        </li>
        <li>
          Or, on this computer, let homectl create a token and configure the
          agent itself:
          <pre className="copy">{setups.join("\n")}</pre>
          <button
            type="button"
            onClick={() => copy("setup commands", setups.join("\n"))}
          >
            Copy setup commands
          </button>
        </li>
      </ol>
    </section>
  );
}

function CreateAgent({
  onCreated,
  onError,
}: {
  onCreated: (result: Issued) => void;
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [hosts, setHosts] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      const result = await ownerCall<Issued>("/v1/owner/clients/create", {
        id: id.trim(),
        name: name.trim(),
        hosts: hosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
        password: secret,
      });
      setId("");
      setName("");
      setHosts("");
      onCreated(result);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${baseId}-title`}>
      <h3 id={`${baseId}-title`}>Add an assistant</h3>
      <form className="stack" onSubmit={submit}>
        <Field
          id={`${baseId}-id`}
          label="Identifier"
          hint="lowercase, no spaces"
        >
          <input
            id={`${baseId}-id`}
            value={id}
            required
            pattern="[a-z][a-z0-9-]{0,62}"
            onChange={(event) => setId(event.target.value)}
          />
        </Field>
        <Field id={`${baseId}-name`} label="Name">
          <input
            id={`${baseId}-name`}
            value={name}
            required
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field id={`${baseId}-hosts`} label="Hosts" hint="comma separated">
          <input
            id={`${baseId}-hosts`}
            value={hosts}
            onChange={(event) => setHosts(event.target.value)}
          />
        </Field>
        <PasswordStep value={password} onChange={setPassword} />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <button
          type="submit"
          className="primary"
          disabled={busy || !password || !id || !name}
        >
          Create agent
        </button>
      </form>
    </section>
  );
}

function RowActions({
  client,
  busy,
  onRotated,
  onRun,
  onError,
}: {
  client: ClientView;
  busy: boolean;
  onRotated: (result: Issued) => void;
  onRun: (work: () => Promise<void>) => Promise<void>;
  onError: (error: unknown) => unknown;
}) {
  const [rotating, setRotating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          disabled={busy}
          onClick={() => setRotating((v) => !v)}
        >
          Rotate token…
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => setRevoking(true)}
        >
          Revoke…
        </button>
      </div>
      {rotating ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const secret = password;
            setPassword("");
            setRotating(false);
            void onRun(async () => {
              const result = await ownerCall<Issued>(
                "/v1/owner/clients/rotate",
                {
                  id: client.id,
                  password: secret,
                },
              );
              onRotated(result);
            });
          }}
        >
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="rotating invalidates the old token"
          />
          <button type="submit" className="primary" disabled={!password}>
            Rotate {client.name}
          </button>
        </form>
      ) : null}
      {revoking ? (
        <Dialog
          title={`Revoke ${client.name}?`}
          onClose={() => setRevoking(false)}
        >
          <p>Its token stops working immediately.</p>
          <div className="row">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setRevoking(false);
                void onRun(async () => {
                  await ownerCall("/v1/owner/clients/revoke", {
                    id: client.id,
                  });
                });
              }}
            >
              Revoke agent
            </button>
            <button type="button" onClick={() => setRevoking(false)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
