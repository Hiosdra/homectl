// "Add an assistant": the name is the only thing the owner must type; the identifier
// is derived from it (and editable under Advanced), machines are picked from the
// machines the other assistants already use, and the owner password confirms the
// change. The key is shown once, here, as it always was; the next steps say how to
// connect the assistant and offer the matching command to copy.
import { type FormEvent, useId, useState } from "react";
import { type ClientView, describeError, ownerCall } from "./api";
import { CopyButton } from "./copy";
import { displayName } from "./plain-words";
import { Field, Notice, PasswordStep, Badge } from "./ui";

export interface Issued {
  client: ClientView;
  token: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

// The identifier the broker stores, from a name: "Claude Desktop" becomes
// "claude-desktop". Empty when the name has no letters or digits.
export function idFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (slug === "") return "";
  return /^[a-z]/.test(slug) ? slug : `a-${slug}`.slice(0, 63);
}

// Every machine that an assistant already uses, once each, sorted. These are the
// hosts the clients list already returns; nothing else is asked of the broker.
export function knownMachines(clients: ClientView[]): string[] {
  return [...new Set(clients.flatMap((client) => client.hosts))].sort();
}

// The command that connects the assistant the panel just created. --client reuses
// that id (and rotates its key) instead of creating a second assistant.
export function connectCommand(id: string, hosts: string[]): string {
  const kind = id === "codex" || id === "claude" ? id : "other";
  const list = hosts.length > 0 ? hosts.join(",") : "<machine>";
  return `home-ctl agent connect ${kind} --client ${id} --hosts ${list}`;
}

export function AddAssistant({
  clients,
  machines: inventory,
  onCreated,
  onError,
}: {
  clients: ClientView[];
  // The machines in the inventory, when the caller has them (the setup wizard does).
  // Without them, the machines the existing assistants use are offered.
  machines?: string[];
  onCreated: (result: Issued) => void;
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const machines = inventory ?? knownMachines(clients);
  const [name, setName] = useState("");
  const [idOverride, setIdOverride] = useState<string | undefined>();
  const [picked, setPicked] = useState<string[]>([]);
  const [typedMachines, setTypedMachines] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const id = idOverride ?? idFromName(name);
  const hosts =
    machines.length > 0
      ? picked
      : typedMachines
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean);
  // Why the button is off, in plain words, so the owner knows what is missing.
  const missing: string[] = [];
  if (name.trim() === "") missing.push("a name");
  if (name.trim() !== "" && !ID_PATTERN.test(id))
    missing.push("an identifier (Advanced)");
  if (hosts.length === 0) missing.push("at least one machine");
  if (password.length === 0) missing.push("your password");
  const ready = missing.length === 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !ready) return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      const result = await ownerCall<Issued>("/v1/owner/clients/create", {
        id,
        name: name.trim(),
        hosts,
        password: secret,
      });
      setName("");
      setIdOverride(undefined);
      setPicked([]);
      setTypedMachines("");
      onCreated(result);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (machine: string) =>
    setPicked((current) =>
      current.includes(machine)
        ? current.filter((item) => item !== machine)
        : [...current, machine],
    );

  return (
    <section aria-labelledby={`${baseId}-title`}>
      <h3 id={`${baseId}-title`}>Add an assistant</h3>
      <p className="small muted">
        An assistant is an AI tool, such as Claude or Codex. It gets its own key
        and can only use the machines you pick.
      </p>
      <form className="stack" onSubmit={submit}>
        <Field id={`${baseId}-name`} label="Name">
          <input
            id={`${baseId}-name`}
            value={name}
            required
            maxLength={100}
            placeholder="for example, Claude"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <fieldset>
          <legend>Machines it may use</legend>
          {machines.length > 0 ? (
            <div className="radio-group">
              {machines.map((machine) => (
                <label key={machine} className="check-row">
                  <input
                    type="checkbox"
                    checked={picked.includes(machine)}
                    onChange={() => toggle(machine)}
                  />
                  <span>{machine}</span>
                </label>
              ))}
            </div>
          ) : (
            <Field
              id={`${baseId}-machines`}
              label="Machine names"
              hint="comma separated"
            >
              <input
                id={`${baseId}-machines`}
                value={typedMachines}
                onChange={(event) => setTypedMachines(event.target.value)}
              />
            </Field>
          )}
        </fieldset>

        <details className="advanced">
          <summary>Advanced</summary>
          <Field
            id={`${baseId}-id`}
            label="Identifier"
            hint="lowercase, no spaces; filled in from the name"
          >
            <input
              id={`${baseId}-id`}
              value={id}
              pattern="[a-z][a-z0-9\-]{0,62}"
              onChange={(event) => setIdOverride(event.target.value)}
            />
          </Field>
        </details>

        <PasswordStep value={password} onChange={setPassword} />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="request-actions">
          <button type="submit" className="primary" disabled={busy || !ready}>
            Add assistant
          </button>
        </div>
        {!ready && !busy ? (
          <p className="small muted" role="note">
            To add it: {missing.join(", ")}.
          </p>
        ) : null}
      </form>
    </section>
  );
}

// The key, shown once, and the next steps. The key stays in this component's state
// only: the owner dismisses it, or it goes when the screen is left.
export function NewKey({
  issued,
  onDismiss,
}: {
  issued: Issued;
  onDismiss: () => void;
}) {
  const name = displayName(issued.client.id);
  const command = connectCommand(issued.client.id, issued.client.hosts);
  return (
    <section aria-labelledby="token-title">
      <div className="row between">
        <h3 id="token-title">Key for {issued.client.name || name}</h3>
        <Badge tone="good" icon="check">
          Added
        </Badge>
      </div>
      <Notice tone="warn">
        Shown once. Copy it now; it cannot be displayed again. Getting a new key
        later stops this one working.
      </Notice>
      <pre className="copy" aria-label="Assistant key">
        {issued.token}
      </pre>
      <div className="row">
        <CopyButton label="key" text={issued.token} primary />
        <button type="button" onClick={onDismiss}>
          I have copied it
        </button>
      </div>
      <h3 className="sub-title">Connect {name}</h3>
      <ol className="plain-steps">
        <li>
          On this computer, run this command. It sets {name} up to use the
          machines you picked.
          <pre className="copy">{command}</pre>
          <CopyButton label="command" text={command} />
        </li>
        <li>
          Or give the key above to {name} as <code>HOMECTL_TOKEN</code>. Never
          paste it into a chat.
        </li>
      </ol>
    </section>
  );
}
