// Assistants (the broker's clients): what each one may do, on which machines, and
// the owner's three changes: a new key, removing access, and adding one. A key is
// shown once, when it is created or replaced; it is kept only in this component's
// state and dropped when the owner dismisses it or leaves the screen.
import { useEffect, useState } from "react";
import { type ClientView, describeError, ownerCall } from "./api";
import { AddAssistant, type Issued, NewKey } from "./agent-form";
import { sharedNameIds } from "./assistant-labels";
import { listMachines } from "./machine-api";
import { displayName } from "./plain-words";
import { SetupLink } from "./setup-checklist";
import { relativeTime, toEpoch } from "./time";
import { Badge, Dialog, Notice, PasswordStep } from "./ui";

// What an assistant may do, in one plain sentence, from the scopes the broker
// stores. The scope names stay under Details; the owner reads the sentence.
export function assistantSentence(scopes: string[]): string {
  if (scopes.includes("plan:create"))
    return "It can ask you to approve changes on its machines. Each one waits for you.";
  if (scopes.includes("inspect:read") || scopes.includes("status:read"))
    return "It can only look around on its machines. It cannot change anything.";
  return "It has no permissions yet.";
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
  // The machines in the inventory. Until they are read, the form waits.
  const [machines, setMachines] = useState<string[] | undefined>();

  useEffect(() => {
    let current = true;
    listMachines()
      .then((data) => {
        if (current) setMachines(data.machines.map((machine) => machine.name));
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [onError]);

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
    // The one-time key is dropped when the screen unmounts.
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

  const active = clients?.filter((client) => !client.revoked) ?? [];
  const removed = clients?.filter((client) => client.revoked) ?? [];
  // Two assistants with the same name show their id after it, so each row is told apart.
  const shared = sharedNameIds(clients ?? []);

  return (
    <>
      <div className="page-head">
        <h2>Assistants</h2>
        <p>
          An assistant is an AI tool, such as Claude or Codex, that asks homectl
          to run commands on your machines. Each one has its own key and only
          the machines you give it. Removing one does not affect the others.
        </p>
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {issued ? (
        <NewKey issued={issued} onDismiss={() => setIssued(undefined)} />
      ) : null}

      <div className="group" aria-labelledby="agents-list">
        <h3 id="agents-list" className="group-title">
          Your assistants
        </h3>
        {clients === undefined ? <p className="muted">Loading…</p> : null}
        {clients?.length === 0 ? (
          <p className="muted">
            No assistants yet. Add one below to let Claude or Codex ask homectl
            for work on your machines.
          </p>
        ) : null}
        <div className="request-list">
          {active.map((client) => (
            <AssistantRow
              key={client.id}
              client={client}
              showId={shared.has(client.id)}
              busy={busy}
              onRotated={setIssued}
              onRun={run}
            />
          ))}
        </div>
        {removed.length > 0 ? (
          <div className="removed-list">
            <h4>Access removed</h4>
            {removed.map((client) => (
              <p key={client.id} className="small muted">
                {displayName(client.id)} no longer has access.
              </p>
            ))}
          </div>
        ) : null}
      </div>
      {machines !== undefined && machines.length === 0 ? (
        <section className="empty" aria-label="Add a machine first">
          <h3>An assistant needs a machine to work on</h3>
          <p>
            Add your first machine, then come back here to connect an assistant.
          </p>
          <p>
            <SetupLink step="machine">Add a machine first →</SetupLink>
          </p>
        </section>
      ) : (
        <AddAssistant
          clients={clients ?? []}
          machines={machines}
          onCreated={(result) => {
            setIssued(result);
            void load();
          }}
          onError={onError}
        />
      )}
    </>
  );
}

function AssistantRow({
  client,
  showId,
  busy,
  onRotated,
  onRun,
}: {
  client: ClientView;
  // True when another assistant has the same name: the id is then shown quietly.
  showId: boolean;
  busy: boolean;
  onRotated: (result: Issued) => void;
  onRun: (work: () => Promise<void>) => Promise<void>;
}) {
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState("");
  const name = client.name || displayName(client.id);
  // Names the row in a dialog title, with the id when the name is shared.
  const label = showId ? `${name} · ${client.id}` : name;
  const created = toEpoch(client.createdAt);
  return (
    <div className="item request-card assistant-card">
      <div className="request-head">
        <span className="assistant-tag">
          <span className="assistant-name">
            {name}
            {showId ? (
              <span className="assistant-id"> · {client.id}</span>
            ) : null}
          </span>
        </span>
        <Badge tone="good" icon="check">
          Active
        </Badge>
      </div>
      <div className="chips" aria-label={`${name} machines`}>
        {client.hosts.length > 0 ? (
          client.hosts.map((host) => (
            <span className="chip" key={host}>
              {host}
            </span>
          ))
        ) : (
          <span className="small muted">No machines yet</span>
        )}
      </div>
      <p className="small">{assistantSentence(client.scopes)}</p>
      <p className="request-meta">
        {created !== undefined
          ? `Added ${relativeTime(created)}`
          : "Added at an unknown time"}
      </p>
      <div className="request-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => setReplacing((open) => !open)}
        >
          Get a new key…
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => setRemoving(true)}
        >
          Remove access…
        </button>
      </div>
      {replacing ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const secret = password;
            setPassword("");
            setReplacing(false);
            void onRun(async () => {
              const result = await ownerCall<Issued>(
                "/v1/owner/clients/rotate",
                { id: client.id, password: secret },
              );
              onRotated(result);
            });
          }}
        >
          <p className="small muted">
            This makes a new key for {name}. The old key stops working at once,
            so paste the new one into {name} straight away.
          </p>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to get a new key"
          />
          <button type="submit" className="primary" disabled={!password}>
            Get a new key
          </button>
        </form>
      ) : null}
      {removing ? (
        <Dialog
          title={`Remove access for ${label}?`}
          onClose={() => setRemoving(false)}
        >
          <p>
            {name} can no longer ask homectl for anything. Its key stops working
            at once. To add an assistant like this again, use a different name:
            this name stays reserved.
          </p>
          <div className="row">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setRemoving(false);
                void onRun(async () => {
                  await ownerCall("/v1/owner/clients/revoke", {
                    id: client.id,
                  });
                });
              }}
            >
              Remove access
            </button>
            <button type="button" onClick={() => setRemoving(false)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
