// The panel's first screen when it is not connected, as in the approved design. The vault
// password is sealed in this browser to the server key before it is sent (ADR-0003). The
// key fingerprint is pinned per host; a changed key blocks the form until the user trusts
// it on purpose.
import { type FormEvent, useEffect, useState } from "react";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { BrandMark } from "./brand";
import { Tag } from "./shared";
import { fromHex, sealPassword } from "./unlock-seal";

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

// HTTPS, or this computer: the password needs no sealing in the browser.
const onThisComputer = () =>
  location.protocol === "https:" ||
  ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);

export function UnlockConnect({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState<KeyInfo | undefined>();
  const [pinned, setPinned] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPinned(readPin());
    void call<KeyInfo>("/api/unlock/key").then((answer) => {
      if (answer.status === 200) setKey(answer.body);
      else setError(answer.body.error ?? "The panel did not return its key.");
    });
  }, []);

  const changed = key !== undefined && pinned !== null && pinned !== key.fingerprint;
  const local = onThisComputer();

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
      <div className="grid w-full max-w-[640px] gap-5">
        <div className="flex items-center gap-2.5 text-[22px] font-bold tracking-[-0.025em]">
          <BrandMark />
          homectl
        </div>
        <h1 className="text-[38px] leading-[1.15] font-semibold tracking-[-0.025em] max-[700px]:text-[32px]">
          Unlock homectl
        </h1>
        <p className="text-muted-foreground">
          Your vault password is the only password you need here. One unlock lasts the session length set in
          Settings (24 h by default).
        </p>
        {changed ? (
          <Alert id="connection-error" variant="error">
            <AlertDescription>
              The server key changed since your last visit. Do not enter your password until you have checked the new
              key in the terminal.{" "}
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
        <section
          className={`grid gap-4 rounded-panel border bg-card p-5 max-[700px]:p-4 ${local ? "border-border" : "border-warning"}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {local ? "Served over HTTPS or on this computer" : "Served over plain HTTP on the LAN"}
            </h2>
            {local ? null : <Tag tone="success">encrypted in browser</Tag>}
          </div>
          {local ? (
            <p className="text-muted-foreground">Unlock with your vault password.</p>
          ) : (
            <p className="text-muted-foreground">
              The password is encrypted in this browser with the server key before it is sent. Server key:{" "}
              <code id="server-fingerprint">{key?.fingerprint ?? "…"}</code> (compare once with the terminal).
            </p>
          )}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                type="submit"
                className="border-success bg-success text-background hover:bg-success/90"
                disabled={!key || changed || busy}
              >
                {busy ? "Unlocking…" : "Unlock"}
              </Button>
              <span className="text-xs text-muted-foreground">
                {local
                  ? "Locks again after the idle time set in Settings"
                  : "Blocks passive sniffing. Not an attacker who can change pages on your LAN."}
              </span>
            </div>
          </form>
        </section>
        <section className="rounded-panel border border-border p-5 max-[700px]:p-4">
          <h2 className="mb-1.5 text-lg font-semibold">After 5 wrong passwords</h2>
          <p className="text-muted-foreground">
            Unlock pauses for 60 seconds. The counter resets after a successful unlock.
          </p>
        </section>
      </div>
    </div>
  );
}
