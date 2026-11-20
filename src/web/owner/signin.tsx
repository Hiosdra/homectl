// Owner sign-in. The password goes to the broker in one request body and is
// cleared from the form at once. The broker answers with a session cookie that
// the browser keeps (HttpOnly, SameSite=Strict); no token is stored here.
import { type FormEvent, useState } from "react";
import { describeError, ownerCall } from "./api";
import { Icon } from "./icons";
import { Field, Notice } from "./ui";

export function SignInScreen({
  notice,
  onSignedIn,
}: {
  notice?: string;
  onSignedIn: (expiresAt: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const attempt = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      const session = await ownerCall<{ expiresAt: string }>(
        "/v1/owner/login",
        { password: attempt },
      );
      onSignedIn(session.expiresAt);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <section>
        <div className="brand-large">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="shield" />
          </span>
          <h1>homectl owner</h1>
        </div>
        <h2>Sign in to decide</h2>
        <p className="small muted">
          Approvals, secrets and assistant access are decided here, by you. For
          safety your session ends after 15 minutes of use.
        </p>
        {notice ? <Notice tone="warn">{notice}</Notice> : null}
        <form className="stack" method="post" onSubmit={submit}>
          <Field id="owner-password" label="Owner password">
            <input
              id="owner-password"
              name="password"
              type="password"
              enterKeyHint="done"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}
