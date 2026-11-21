// Steps 4 and 5: confirm the machine's identity, then add it. The scan shows what
// the address presents, labelled not verified. The owner compares it with the
// machine's own console and types the fingerprint; only an exact match moves on.
// Trust is saved by the enrolment itself, with the owner password.
import { type FormEvent, useId, useState } from "react";
import {
  type EnrollInput,
  type ScanKey,
  type ScanResult,
  enrollMachine,
  scanMachine,
} from "./machine-api";
import { fingerprintMatch } from "./machine-words";
import { describeError } from "./api";
import { Badge, Field, Notice, PasswordStep } from "./ui";

export function IdentityStep({
  address,
  port,
  onConfirmed,
}: {
  address: string;
  port: number;
  onConfirmed: (fingerprint: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [scan, setScan] = useState<ScanResult | undefined>();
  const [typed, setTyped] = useState("");
  const typedId = useId();
  const match = scan ? fingerprintMatch(typed, scan.keys) : undefined;
  const wrong = typed.trim() !== "" && !match;

  const look = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (busy || password === "") return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      setScan(await scanMachine(address, port, secret));
      setTyped("");
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 id={`${typedId}-why`}>Check that this is your machine</h3>
      <p>
        Anyone can answer at an address. Before homectl trusts a machine, it has
        to know the machine's own key, or someone else could read the commands
        you send. What the address shows below is not proof. Compare it with the
        machine itself.
      </p>

      <form className="stack" onSubmit={(event) => void look(event)}>
        <PasswordStep
          value={password}
          onChange={setPassword}
          hint="to look at the machine"
        />
        <button type="submit" disabled={busy || password === ""}>
          {scan ? "Look again" : "Look at the machine"}
        </button>
      </form>
      {error ? <Notice tone="bad">{error}</Notice> : null}

      {scan ? (
        <>
          <Notice>{scan.notice}</Notice>
          <ul className="plain-list-bare key-list" aria-label="Presented keys">
            {scan.keys.map((key) => (
              <KeyRow key={`${key.type}-${key.fingerprint}`} item={key} />
            ))}
          </ul>
          {scan.keys.every((key) => key.revoked) ? (
            <Notice tone="bad">
              Every key this address shows has been revoked. Check the address.
            </Notice>
          ) : null}

          <h4>Compare it on the machine itself</h4>
          <p className="small">
            On a Linux machine, run this on the machine, or read the fingerprint
            from its console or its provider's page. Do not copy it from this
            screen.
          </p>
          <div className="command-block">
            <pre
              className="key-block"
              tabIndex={0}
              aria-label="Fingerprint command"
            >
              ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
            </pre>
          </div>

          <Field
            id={`${typedId}-typed`}
            label="Fingerprint from the machine"
            hint="type or paste it"
          >
            <input
              id={`${typedId}-typed`}
              className="mono"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="SHA256:"
              value={typed}
              aria-invalid={wrong ? true : undefined}
              aria-describedby={`${typedId}-state`}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
          <p
            id={`${typedId}-state`}
            className={match ? "match good" : "match"}
            role="status"
          >
            {match
              ? "It matches the key above. You can continue."
              : wrong
                ? "It does not match yet. Check each character, starting with SHA256:."
                : "Nothing is trusted yet. Continue only after the two match exactly."}
          </p>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!match}
              onClick={() => match && onConfirmed(match.fingerprint)}
            >
              Continue
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function KeyRow({ item }: { item: ScanKey }) {
  return (
    <li className="key-row">
      <span className="small muted">{item.type}</span>
      <span className="mono key-fingerprint">{item.fingerprint}</span>
      {item.revoked ? (
        <Badge tone="bad" icon="alert">
          Revoked: cannot be used
        </Badge>
      ) : (
        <Badge tone="warn" icon="alert">
          Not verified yet
        </Badge>
      )}
    </li>
  );
}

export function EnrollStep({
  input,
  summary,
  onAdded,
  onBack,
}: {
  // Everything but the password; the password is typed here and sent once.
  input: Omit<EnrollInput, "password">;
  summary: string;
  onAdded: (result: { name: string; os: string }) => void;
  onBack: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || password === "") return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      const result = await enrollMachine({ ...input, password: secret });
      onAdded({ name: result.name, os: result.os });
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p>{summary}</p>
      <p className="small muted">
        Adding it trusts the key you confirmed, saves the machine to your list,
        and runs one read-only check. If the check fails, the trust is taken
        back.
      </p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <PasswordStep
          value={password}
          onChange={setPassword}
          hint="required to trust this machine"
        />
        {busy ? (
          <p className="small muted" role="status">
            Connecting to the machine and checking what it runs…
          </p>
        ) : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="row">
          <button
            type="submit"
            className="primary"
            disabled={busy || password === ""}
          >
            Add the machine
          </button>
          <button type="button" onClick={onBack} disabled={busy}>
            Back
          </button>
        </div>
      </form>
    </div>
  );
}
