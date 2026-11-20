// Auto Mode settings under Permissions: the mode, the reviewer's authority, and
// the reviewer connection. The reviewer's verdict is never a human approval, and
// human-only and step-up operations never auto-approve. The form opens on the
// saved settings; the owner password is asked for only when the broker says the
// change needs it.
import { type FormEvent, useEffect, useId, useState } from "react";
import { describeError } from "./api";
import {
  authorityHint,
  authorityLabel,
  type AutoModeDraft,
  type AutoModeName,
  type AutoModeView,
  autoModeChange,
  AUTO_MODES,
  draftOf,
  modeHint,
  modeLabel,
  needsOwnerPassword,
  readAutoMode,
  REVIEWER_AUTHORITIES,
  type ReviewerAuthority,
  saveAutoMode,
} from "./auto-mode-api";
import { Badge, Field, Notice, PasswordStep } from "./ui";

type Load =
  | { state: "loading" }
  | { state: "absent" }
  | { state: "ready"; view: AutoModeView }
  | { state: "failed"; message: string };

export function AutoModeSection({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let current = true;
    readAutoMode()
      .then((view) => {
        if (current)
          setLoad(view ? { state: "ready", view } : { state: "absent" });
      })
      .catch((failure) => {
        onError(failure);
        if (current)
          setLoad({ state: "failed", message: describeError(failure) });
      });
    return () => {
      current = false;
    };
  }, [onError]);

  return (
    <section aria-labelledby="auto-mode-heading">
      <h3 id="auto-mode-heading">Auto Mode settings</h3>
      <Notice>
        The reviewer&apos;s verdict is not a human approval. It can decide only
        inside the authority chosen here, and only for requests the rules leave
        open. Human-only operations and step-up operations never auto-approve:
        they wait for you whatever the reviewer says.
      </Notice>
      {load.state === "loading" ? <p className="muted">Checking…</p> : null}
      {load.state === "absent" ? (
        <p className="small muted">
          This broker does not report Auto Mode settings yet. Update it to
          change them here.
        </p>
      ) : null}
      {load.state === "failed" ? (
        <Notice tone="bad">{load.message}</Notice>
      ) : null}
      {load.state === "ready" ? (
        <AutoModeEditor
          key={load.view.revision}
          initial={load.view}
          onError={onError}
        />
      ) : null}
    </section>
  );
}

function AutoModeEditor({
  initial,
  onError,
}: {
  initial: AutoModeView;
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<AutoModeDraft>(() => draftOf(initial));
  const [password, setPassword] = useState("");
  // Set only after the broker refuses a change for want of the password.
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const change = autoModeChange(view, draft);
  const reviewer = view.reviewer;

  // Sends the change. The first try carries no password: a change that needs
  // none goes through at once. A refusal for want of the password asks for it.
  const save = async (withPassword: boolean) => {
    if (busy || !change) return;
    // Take the password out of the form before the request leaves.
    const secret = withPassword ? password : "";
    setPassword("");
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const saved = await saveAutoMode({
        ...change,
        ...(secret ? { password: secret } : {}),
      });
      setView(saved);
      setDraft(draftOf(saved));
      setNeedsPassword(false);
      setNotice(`Saved. Policy revision ${saved.revision}.`);
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void save(needsPassword);
  };

  return (
    <div className="stack">
      {notice ? <Notice tone="good">{notice}</Notice> : null}
      <dl>
        <dt>Mode</dt>
        <dd>
          <Badge tone={view.mode === "auto" ? "warn" : "neutral"}>
            {modeLabel(view.mode)}
          </Badge>
        </dd>
        <dt>Reviewer may</dt>
        <dd>
          {authorityLabel(reviewer.authority)}.{" "}
          {authorityHint(reviewer.authority)}
        </dd>
        <dt>Reviewer endpoint</dt>
        <dd>
          {reviewer.endpoint === undefined
            ? "None. The owner decides every request that needs a judgment."
            : `${reviewer.endpoint} (origin only). Requests it reviews leave this computer.`}
        </dd>
        <dt>Reviewer model</dt>
        <dd>{reviewer.model ?? "Not set"}</dd>
        <dt>API key</dt>
        <dd>
          <Badge tone={reviewer.apiKeyConfigured ? "good" : "neutral"}>
            {reviewer.apiKeyConfigured ? "Configured" : "Not configured"}
          </Badge>{" "}
          <span className="small muted">
            Set on the broker, never here. This panel does not show or accept
            it.
          </span>
        </dd>
        <dt>Reviewer</dt>
        <dd>
          <Badge tone={reviewer.ready ? "good" : "neutral"}>
            {reviewer.ready ? "Ready" : "Not ready"}
          </Badge>
        </dd>
      </dl>

      <form className="stack" onSubmit={submit}>
        <h4>Change Auto Mode</h4>
        <Field id={`${baseId}-mode`} label="Mode">
          <select
            id={`${baseId}-mode`}
            value={draft.mode}
            onChange={(event) =>
              setDraft({
                ...draft,
                mode: event.target.value as AutoModeName,
              })
            }
          >
            {AUTO_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel(mode)}
                {mode === "manual" ? " (least privilege)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <p className="small muted">{modeHint(draft.mode)}</p>

        <Field id={`${baseId}-authority`} label="Reviewer may">
          <select
            id={`${baseId}-authority`}
            value={draft.authority}
            onChange={(event) =>
              setDraft({
                ...draft,
                authority: event.target.value as ReviewerAuthority,
              })
            }
          >
            {REVIEWER_AUTHORITIES.map((authority) => (
              <option key={authority} value={authority}>
                {authorityLabel(authority)}
                {authority === "recommend" ? " (least privilege)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <p className="small muted">{authorityHint(draft.authority)}</p>

        <Field
          id={`${baseId}-endpoint`}
          label="Reviewer endpoint"
          hint="blank keeps the current one"
        >
          <input
            id={`${baseId}-endpoint`}
            type="url"
            autoComplete="off"
            placeholder="https://reviewer.example.test/v1"
            value={draft.endpoint}
            disabled={draft.clearEndpoint}
            onChange={(event) =>
              setDraft({ ...draft, endpoint: event.target.value })
            }
          />
        </Field>
        {reviewer.endpoint !== undefined ? (
          <label className="row">
            <input
              type="checkbox"
              checked={draft.clearEndpoint}
              onChange={(event) =>
                setDraft({ ...draft, clearEndpoint: event.target.checked })
              }
            />
            Remove the reviewer endpoint
          </label>
        ) : null}
        <Field
          id={`${baseId}-model`}
          label="Reviewer model"
          hint="blank keeps the current one"
        >
          <input
            id={`${baseId}-model`}
            type="text"
            autoComplete="off"
            value={draft.model}
            onChange={(event) =>
              setDraft({ ...draft, model: event.target.value })
            }
          />
        </Field>

        {needsPassword ? (
          <Notice tone="warn">
            This change needs your owner password: it raises the reviewer&apos;s
            authority, turns Auto Mode on, or sends the reviewer to a new
            endpoint. Nothing has changed yet.
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
            type="submit"
            className="primary"
            disabled={busy || !change || (needsPassword && !password)}
          >
            {needsPassword ? "Confirm and save" : "Save Auto Mode settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
