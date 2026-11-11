// The panel's first screen when it is not connected. The vault password is sealed in
// this browser to the server key before it is sent (ADR-0003). The key fingerprint is
// pinned per host. A changed key blocks the form until the user trusts it on purpose.
import { type FormEvent, useEffect, useState } from "react";
import { fingerprint, fromHex, sealPassword } from "./unlock-seal";

type KeyInfo = { pub: string; fingerprint: string };
type Answer<T> = { status: number; body: T & { error?: string } };

const pinKey = () => `homectl:panel-key:${location.host}`;

function readPin(): string | null {
  try {
    return localStorage.getItem(pinKey());
  } catch {
    return null;
  }
}

function writePin(value: string) {
  try {
    localStorage.setItem(pinKey(), value);
  } catch {
    // Private windows may refuse storage. The key is then checked again next time.
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  return { status: response.status, body };
}

export function UnlockConnect({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState<KeyInfo | undefined>();
  const [pinned, setPinned] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    setPinned(readPin());
    void call<KeyInfo>("/api/unlock/key").then((answer) => {
      if (answer.status === 200) setKey(answer.body);
      else setError(answer.body.error ?? "The panel did not return its key.");
    });
  }, []);

  const changed = key !== undefined && pinned !== null && pinned !== key.fingerprint;

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!key || changed) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem("password") as HTMLInputElement;
    const password = input.value;
    input.value = "";
    setBusy(true);
    setError(undefined);
    try {
      // First use pins the key the user is shown here. Compare it once with the terminal.
      if (pinned === null) {
        writePin(key.fingerprint);
        setPinned(key.fingerprint);
      }
      const challenge = await call<{ challenge: string }>("/api/unlock/challenge");
      if (challenge.status !== 200) throw new Error(challenge.body.error ?? "No challenge.");
      const envelope = sealPassword(password, fromHex(key.pub), challenge.body.challenge);
      const answer = await call<{ unlocked?: boolean }>("/api/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (answer.status !== 200) throw new Error(answer.body.error ?? "Unlock failed.");
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  function trustChangedKey() {
    if (!key) return;
    writePin(key.fingerprint);
    setPinned(key.fingerprint);
  }

  return (
    <div id="connection" className="connection">
      <div className="connection-form">
        <div className="brand">
          <span className="brand-mark">h</span>homectl
        </div>
        <h1>Unlock homectl</h1>
        <p className="muted">
          Your vault password is the only password for this panel. It is encrypted in this
          browser before it is sent.
        </p>
        {key ? (
          <p className="muted">
            Server key: <code id="server-fingerprint">{key.fingerprint}</code>. Compare it
            once with the terminal.
          </p>
        ) : null}
        {changed ? (
          <div id="connection-error" role="alert">
            The server key changed since your last visit. Do not enter your password until
            you have checked the new key in the terminal.{" "}
            <button type="button" onClick={trustChangedKey}>
              Trust the new key
            </button>
          </div>
        ) : null}
        {error ? (
          <div id="connection-error" role="alert">
            {error}
          </div>
        ) : null}
        <form id="unlock-form" onSubmit={(event) => void unlock(event)}>
          <label htmlFor="password">Vault password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required disabled={!key || changed || busy} />
          <button className="primary" type="submit" disabled={!key || changed || busy}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
        <details open={showCode} onToggle={(event) => setShowCode(event.currentTarget.open)}>
          <summary className="muted">Use a workspace access code instead</summary>
          <form
            id="connect-form"
            onSubmit={(event) => {
              event.preventDefault();
              const input = event.currentTarget.elements.namedItem("token") as HTMLInputElement;
              const token = input.value;
              input.value = "";
              void call("/api/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
              }).then((answer) => {
                if (answer.status === 200) onDone();
                else setError(answer.body.error ?? "Invalid workspace access code.");
              });
            }}
          >
            <label htmlFor="token">Workspace access code</label>
            <input id="token" name="token" type="password" autoComplete="off" required />
            <button type="submit">Open workspace</button>
          </form>
        </details>
      </div>
    </div>
  );
}
