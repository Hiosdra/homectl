// The panel's first screen when it is not connected. The vault password is sealed in
// this browser to the server key before it is sent (ADR-0003). The key fingerprint is
// pinned per host. A changed key blocks the form until the user trusts it on purpose.
import { type FormEvent, useEffect, useState } from "react";
import { fromHex, sealPassword } from "./unlock-seal";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Disclosure } from "./disclosure";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

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
    <div id="connection" className="grid min-h-dvh place-items-center p-8 max-[700px]:p-4">
      <div className="grid w-full max-w-[500px] gap-5">
        <div className="mb-6 flex items-center gap-2.5 text-[22px] font-bold tracking-[-0.025em]">
          <span className="grid size-[30px] place-items-center rounded-[9px] bg-primary text-[23px] text-primary-foreground">h</span>
          homectl
        </div>
        <h1 className="text-[38px] leading-[1.15] font-semibold tracking-[-0.025em] max-[700px]:text-[32px]">
          Unlock homectl
        </h1>
        <p className="text-muted-foreground">
          Open this workspace at <code id="workspace-origin">{location.origin}</code>. Your
          vault password is the only password for this panel. It is encrypted in this
          browser before it is sent.
        </p>
        {key ? (
          <p className="text-muted-foreground">
            Server key: <code id="server-fingerprint">{key.fingerprint}</code>. Compare it
            once with the terminal.
          </p>
        ) : null}
        {changed ? (
          <Alert id="connection-error" variant="error">
            <AlertDescription>
              The server key changed since your last visit. Do not enter your password
              until you have checked the new key in the terminal.{" "}
              <Button type="button" variant="outline" size="sm" onClick={trustChangedKey}>
                Trust the new key
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert id="connection-error" variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <form id="unlock-form" className="grid gap-3" onSubmit={(event) => void unlock(event)}>
          <Label htmlFor="password">Vault password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={!key || changed || busy}
          />
          <div>
            <Button type="submit" disabled={!key || changed || busy}>
              {busy ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
        </form>
        <Disclosure title={<>Use a workspace access code instead</>} panelClassName="grid gap-3 pt-3">
            <p className="text-muted-foreground">
              Local workspaces started with <code>homectl panel</code> open with their
              private link. Compose deployments may still use the code from the protected
              file set as <code>HOMECTL_PANEL_TOKEN_FILE</code>.
            </p>
            <form
              id="connect-form"
              className="grid gap-3"
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
              <Label htmlFor="token">Workspace access code</Label>
              <Input id="token" name="token" type="password" autoComplete="off" required />
              <div>
                <Button type="submit" variant="secondary">Open workspace</Button>
              </div>
            </form>
          </Disclosure>
      </div>
    </div>
  );
}
