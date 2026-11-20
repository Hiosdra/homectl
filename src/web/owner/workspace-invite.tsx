// Invites a client to this server. The one-time code is kept only in this
// component's state; it is dropped when dismissed or when the screen closes.
import { type FormEvent, useEffect, useState } from "react";
import { describeError } from "./api";
import { createWorkspaceInvite, type WorkspaceInvite } from "./workspace-api";
import { fmtTime, Notice, PasswordStep } from "./ui";

export function InviteSection({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [invite, setInvite] = useState<WorkspaceInvite | undefined>();

  useEffect(() => () => setInvite(undefined), []);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    // Take the password out of the form before the request leaves.
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      setInvite(await createWorkspaceInvite(secret));
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="invite-heading">
      <h3 id="invite-heading">Add a client</h3>
      {invite ? (
        <div className="stack">
          <Notice tone="warn">
            Shown once. It admits one client and expires{" "}
            {fmtTime(invite.expiresAt)}.
          </Notice>
          <pre className="copy" aria-label="Invite code">
            {invite.code}
          </pre>
          <p className="small">
            On the client, run{" "}
            <code>
              home-ctl workspace join &lt;server address&gt; &lt;code&gt;
            </code>{" "}
            before it expires. Compare the verification phrase it shows.
          </p>
          <button type="button" onClick={() => setInvite(undefined)}>
            I have entered it
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={create}>
          <p className="small muted">
            Creates a one-time code. Nothing is linked until a client enters it.
          </p>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to invite"
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <button
            type="submit"
            className="primary"
            disabled={busy || !password}
          >
            Create invite code
          </button>
        </form>
      )}
    </section>
  );
}
