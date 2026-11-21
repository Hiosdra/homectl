// "Forget key…": removes the saved AI helper key from the vault. It needs the
// owner password, like every change to a secret. The key is never shown.
import { useState } from "react";
import { describeError } from "./api";
import { forgetAiKey } from "./ai-helper-api";
import type { AutoModeView } from "./auto-mode-api";
import { needsOwnerPassword } from "./auto-mode-api";
import { Notice, PasswordStep } from "./ui";

export function ForgetKey({
  onForgotten,
}: {
  onForgotten: (view: AutoModeView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const forget = async () => {
    if (busy || password.length === 0) return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      onForgotten(await forgetAiKey(secret));
      setOpen(false);
    } catch (failure) {
      setError(
        needsOwnerPassword(failure)
          ? "That owner password was not accepted. Nothing changed."
          : describeError(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button type="button" className="danger" onClick={() => setOpen(true)}>
        Forget key…
      </button>
    );
  // A plain container, not a form: this is often shown inside another form.
  return (
    <div className="stack">
      <Notice tone="warn">
        The AI helper stops deciding until you add a key again. Requests wait
        for you in the meantime.
        <PasswordStep
          value={password}
          onChange={setPassword}
          hint="required to forget the key"
        />
      </Notice>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="row">
        <button
          type="button"
          className="danger"
          onClick={() => void forget()}
          disabled={busy || !password}
        >
          Forget key
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          Keep the key
        </button>
      </div>
    </div>
  );
}
