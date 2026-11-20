// "Who can do what": one plain sentence per assistant and machine, from the
// broker's own answer for that pair. The check under Details picks the assistant
// and the machine from lists, so nobody types an identifier.
import { useEffect, useId, useState } from "react";
import {
  type ClientView,
  type EffectiveView,
  describeError,
  type PolicyDocument,
  type PolicyRule,
  ownerCall,
} from "./api";
import { effectLabel } from "./permissions-copy";
import { pairSentence, ruleCovers } from "./policy-sentences";
import { Badge, Field, Notice } from "./ui";

export function activeClients(clients: ClientView[]): ClientView[] {
  return clients.filter((client) => !client.revoked);
}

export function namesOf(clients: ClientView[]): Record<string, string> {
  return Object.fromEntries(
    clients.map((client) => [client.id, client.name || client.id]),
  );
}

// Every machine an active assistant is allowed on, one entry per pair.
function pairsOf(clients: ClientView[]) {
  return activeClients(clients).flatMap((client) =>
    client.hosts.map((machine) => ({ client, machine })),
  );
}

type Row = { key: string; text: string };

export function WhoCanDo({
  policy,
  clients,
  reviewerReady,
}: {
  policy: PolicyDocument;
  clients: ClientView[];
  reviewerReady: boolean;
}) {
  const [rows, setRows] = useState<Row[] | undefined>();

  useEffect(() => {
    let current = true;
    setRows(undefined);
    Promise.all(
      pairsOf(clients).map(async ({ client, machine }): Promise<Row> => {
        const name = client.name || client.id;
        const key = `${client.id}@${machine}`;
        try {
          const view = await ownerCall<EffectiveView>(
            "/v1/owner/policy/explain",
            { client: client.id, host: machine },
          );
          return {
            key,
            text: pairSentence({
              name,
              machine,
              view,
              rules: policy.rules,
              reviewerReady,
            }),
          };
        } catch {
          return {
            key,
            text: `${name} could not be checked on ${machine} just now.`,
          };
        }
      }),
    ).then((result) => {
      if (current) setRows(result);
    });
    return () => {
      current = false;
    };
  }, [policy, clients, reviewerReady]);

  if (activeClients(clients).length === 0)
    return (
      <p className="muted">
        No assistants are set up yet. Add one on the Assistants page, and it
        will appear here.
      </p>
    );
  if (rows === undefined) return <p className="muted">Checking…</p>;
  if (rows.length === 0)
    return (
      <p className="muted">
        Your assistants are not allowed on any machine yet.
      </p>
    );
  return (
    <ul className="plain-list">
      {rows.map((row) => (
        <li key={row.key}>{row.text}</li>
      ))}
    </ul>
  );
}

// The check for one assistant on one machine, both picked from lists. It shows
// each rule and whether it applies, with the broker's reasons.
export function CheckRules({
  clients,
  rules,
  onError,
}: {
  clients: ClientView[];
  rules: PolicyRule[];
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const active = activeClients(clients);
  const machines = [
    ...new Set([
      ...active.flatMap((client) => client.hosts),
      ...rules.flatMap((rule) =>
        Array.isArray(rule.match.hosts) ? rule.match.hosts.map(String) : [],
      ),
    ]),
  ].sort();
  const [assistant, setAssistant] = useState("");
  const [machine, setMachine] = useState("");
  const [view, setView] = useState<EffectiveView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const names = namesOf(clients);

  return (
    <div className="stack">
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          try {
            setView(
              await ownerCall<EffectiveView>("/v1/owner/policy/explain", {
                client: assistant,
                host: machine,
              }),
            );
          } catch (failure) {
            onError(failure);
            setError(describeError(failure));
          }
        }}
      >
        <Field id={`${baseId}-assistant`} label="Assistant">
          <select
            id={`${baseId}-assistant`}
            value={assistant}
            onChange={(event) => setAssistant(event.target.value)}
          >
            <option value="">Choose an assistant</option>
            {active.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name || client.id}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${baseId}-machine`} label="Machine">
          <select
            id={`${baseId}-machine`}
            value={machine}
            onChange={(event) => setMachine(event.target.value)}
          >
            <option value="">Choose a machine</option>
            {machines.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" disabled={!assistant || !machine}>
          Check
        </button>
      </form>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {view ? (
        <ul className="small plain-list">
          {view.rules.map((entry) => {
            const rule = rules.find((item) => item.id === entry.ruleId);
            return (
              <li key={entry.ruleId}>
                {rule ? `${ruleCovers(rule, names)}: ` : ""}
                {entry.applies
                  ? "this rule applies"
                  : "this rule does not apply"}
                {entry.reasons.length > 0
                  ? ` (${entry.reasons.join("; ")})`
                  : ""}{" "}
                <Badge>{effectLabel(entry.effect)}</Badge>{" "}
                <span className="mono">
                  {entry.effect} · {entry.ruleId}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
