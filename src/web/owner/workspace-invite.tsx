// Pairs a new device with this server, the way a phone is paired: a one-time code
// with a countdown, and the steps for the other device. The code is kept only in this
// component's state; it is dropped when dismissed, when it expires or when the screen
// closes.
import { type FormEvent, useEffect, useState } from "react";
import { describeError } from "./api";
import { CopyButton } from "./copy";
import { PairCode } from "./pair-code";
import { createWorkspaceInvite, type WorkspaceInvite } from "./workspace-api";
import { Argv, Notice, PasswordStep } from "./ui";
import { toEpoch } from "./time";

function suggestedServerAddress(): string {
  if (typeof location === "undefined") return "<server address>";
  const host = location.hostname;
  if (!host || host === "127.0.0.1" || host === "localhost" || host === "[::1]")
    return "<server address>";
  return `http://${host}:7450`;
}

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
      <h3 id="invite-heading">Pair a new device</h3>
      {invite ? (
        <PairCode
          code={invite.code}
          // An unreadable time counts as expired, so a code is never shown as valid
          // when its end is unknown.
          expiresAt={toEpoch(invite.expiresAt) ?? 0}
          title={`Pairing code for ${invite.server.name}`}
          codeLabel="Invite code"
          expiredText="This code has expired, so it cannot be used. Make a new one to pair a device."
          expiredLabel="Make a new code"
          doneLabel="I have entered it"
          onDone={() => setInvite(undefined)}
          steps={(() => {
            const addr = suggestedServerAddress();
            const argv = ["home-ctl", "workspace", "join", addr, invite.code];
            return (
              <ol className="plain-steps">
                <li>
                  On the other device, open <strong>System</strong> in its
                  homectl panel and enter server{" "}
                  <code className="mono">{addr}</code> with code{" "}
                  <code className="mono">{invite.code}</code>.
                </li>
                <li>
                  Or run this command in a terminal:
                  <div className="command-block row between">
                    <Argv argv={argv} />
                    {addr.startsWith("http") ? (
                      <CopyButton label="join command" text={argv.join(" ")} />
                    ) : null}
                  </div>
                </li>
                <li>
                  Check that the other device shows the same verification phrase
                  as its own screen. If it does not match, do not continue.
                </li>
              </ol>
            );
          })()}
        />
      ) : (
        <form className="stack" onSubmit={create}>
          <p className="small muted">
            Makes a one-time code that is shown once. Nothing is linked until
            the other device enters it.
          </p>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to pair"
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <button
            type="submit"
            className="primary"
            disabled={busy || !password}
          >
            Make a pairing code
          </button>
        </form>
      )}
    </section>
  );
}
