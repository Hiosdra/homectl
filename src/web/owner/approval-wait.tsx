import { type FormEvent, useEffect, useId, useState } from "react";
import { describeError, ownerCall } from "./api";
import { Field, Notice } from "./ui";

const PATH = "/v1/owner/settings/approval-wait";
type ApprovalWait = { approvalWaitMs: number; label: string };

export function ApprovalWaitSection({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const id = useId();
  const [saved, setSaved] = useState<ApprovalWait>();
  const [wait, setWait] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let current = true;
    void ownerCall<ApprovalWait>(`${PATH}/get`).then(
      (value) => {
        if (!current) return;
        setSaved(value);
        setWait(
          value.approvalWaitMs === 86_400_000
            ? "24h"
            : `${value.approvalWaitMs / 60_000}m`,
        );
      },
      (failure) => {
        if (current) setError(describeError(failure));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const password = new FormData(form).get("password");
    const field = form.elements.namedItem("password");
    if (field instanceof HTMLInputElement) field.value = "";
    setError(undefined);
    setMessage(undefined);
    setBusy(true);
    try {
      const value = await ownerCall<ApprovalWait>(PATH, { wait, password });
      setSaved(value);
      setMessage(`New requests will wait ${value.label}.`);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>How long requests wait for you</h3>
      <p className="small muted">
        The default is 24 hours. Changes apply to new approval requests.
      </p>
      {saved ? (
        <form
          action={PATH}
          method="post"
          aria-labelledby={`${id}-title`}
          className="stack"
          onSubmit={submit}
        >
          <p className="small muted">Current wait: {saved.label}.</p>
          <Field id={`${id}-wait`} label="Approval window">
            <input
              id={`${id}-wait`}
              name="wait"
              required
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${id}-hint`}
              value={wait}
              onChange={(event) => setWait(event.target.value)}
            />
          </Field>
          <p id={`${id}-hint`} className="small muted">
            Enter a duration from 5 minutes to 7 days, such as 90m, 24h or 7d.
          </p>
          <Field id={`${id}-password`} label="Owner password">
            <input
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <div>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save approval window"}
            </button>
          </div>
        </form>
      ) : !error ? (
        <Notice>Loading approval window…</Notice>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {message ? <Notice tone="good">{message}</Notice> : null}
    </section>
  );
}
