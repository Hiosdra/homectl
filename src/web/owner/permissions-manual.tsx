// The one quiet, advanced option under the three choices: ignore the saved rules and
// ask about every change (the broker's "manual" mode). It is kept out of the main
// choices on purpose. It saves through the same Auto Mode route and the same step-up
// as the AI helper's settings: the owner password is asked only when the broker refuses
// the change without it.
import { useState } from "react";
import { describeError } from "./api";
import { needsOwnerPassword, saveAutoMode } from "./auto-mode-api";
import { Badge, Notice, PasswordStep } from "./ui";

export function ManualModeOption({
  manual,
  onSaved,
  onError,
}: {
  // The saved setting is already manual.
  manual: boolean;
  onSaved: () => void;
  onError: (error: unknown) => unknown;
}) {
  const [password, setPassword] = useState("");
  // Set only after the broker refuses the change for want of the password.
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const save = async (withPassword: boolean) => {
    if (busy) return;
    // Take the password out of the form before the request leaves.
    const secret = withPassword ? password : "";
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      await saveAutoMode({
        mode: "manual",
        ...(secret ? { password: secret } : {}),
      });
      setNeedsPassword(false);
      onSaved();
    } catch (failure) {
      if (needsOwnerPassword(failure)) {
        setNeedsPassword(true);
        if (withPassword)
          setError("That owner password was not accepted. Nothing changed.");
      } else {
        onError(failure);
        setError(describeError(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="advanced">
      <summary>Advanced</summary>
      <div className="stack">
        <p className="small muted">
          Every change waits for you, even one a saved rule would allow. Use it
          only while you are watching closely. Choose one of the three choices
          above to turn it off.
        </p>
        {manual ? (
          <p className="small">
            <Badge tone="info">On now</Badge>
          </p>
        ) : null}
        {needsPassword ? (
          <Notice tone="warn">
            This change needs your owner password. Nothing has changed yet.
            <PasswordStep
              value={password}
              onChange={setPassword}
              hint="required for this change"
            />
          </Notice>
        ) : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="row">
          <button
            type="button"
            className="quiet"
            disabled={busy || manual || (needsPassword && !password)}
            onClick={() => void save(needsPassword)}
          >
            Ignore my saved rules and ask about every change
          </button>
        </div>
      </div>
    </details>
  );
}
