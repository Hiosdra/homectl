// The AI helper section under Permissions: how far the helper may go and (under
// Advanced) where it answers. The helper's answer is never a human approval, and
// requests that need the owner password always wait for the owner. The three
// choices on Permissions set the helper's level; the raw mode and authority are shown
// as controls only for a custom setting. The form opens on the saved settings; the
// owner password is asked for only when the broker says the change needs it.
import { type FormEvent, useEffect, useId, useState } from "react";
import { describeError } from "./api";
import {
  AUTO_MODES,
  type AutoModeDraft,
  type AutoModeName,
  type AutoModeView,
  autoModeChange,
  draftOf,
  needsOwnerPassword,
  readAutoMode,
  REVIEWER_AUTHORITIES,
  type ReviewerAuthority,
  saveAutoMode,
} from "./auto-mode-api";
import {
  authorityHint,
  authorityLabel,
  modeHint,
  modeLabel,
} from "./permissions-copy";
import {
  keySourceLabel,
  providerLabel,
  statusSentence,
} from "./ai-helper-copy";
import { ForgetKey } from "./ai-helper-forget";
import { Badge, Field, Notice, PasswordStep } from "./ui";

type Load =
  | { state: "loading" }
  | { state: "absent" }
  | { state: "ready"; view: AutoModeView }
  | { state: "failed"; message: string };

export function AutoModeSection({
  onError,
  onSaved,
  onConnectHelper,
  custom = false,
}: {
  onError: (error: unknown) => unknown;
  // Called after a saved change, so the Permissions summary is read again.
  onSaved?: () => void;
  // Opens the "Connect your AI helper" steps (0.3), from Advanced.
  onConnectHelper?: () => void;
  // A setting none of the three choices matches: only then are the raw mode and
  // authority shown as controls.
  custom?: boolean;
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
    <section aria-labelledby="ai-helper-heading">
      <h3 id="ai-helper-heading">The AI helper</h3>
      <Notice>
        The AI helper&apos;s answer is not your approval. It decides only within
        what you allow, and only for requests no saved rule already covers.
        Requests that need your owner password always wait for you, whatever the
        helper says.
      </Notice>
      {load.state === "loading" ? <p className="muted">Checking…</p> : null}
      {load.state === "absent" ? (
        <p className="small muted">
          This homectl version does not show these settings yet. Update it to
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
          custom={custom}
          onError={onError}
          onSaved={onSaved}
          onConnectHelper={onConnectHelper}
        />
      ) : null}
    </section>
  );
}

function AutoModeEditor({
  initial,
  custom,
  onError,
  onSaved,
  onConnectHelper,
}: {
  initial: AutoModeView;
  custom: boolean;
  onError: (error: unknown) => unknown;
  onSaved?: () => void;
  onConnectHelper?: () => void;
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
      setNotice(`Saved (version ${saved.revision}).`);
      onSaved?.();
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
        {custom ? (
          <>
            <dt>Setting</dt>
            <dd>
              <Badge tone={view.mode === "auto" ? "warn" : "neutral"}>
                {modeLabel(view.mode)}
              </Badge>
            </dd>
          </>
        ) : null}
        <dt>The AI helper may</dt>
        <dd>{authorityLabel(reviewer.authority)}.</dd>
        <dt>AI helper ready</dt>
        <dd>
          <Badge tone={reviewer.ready ? "good" : "neutral"}>
            {reviewer.ready ? "Yes" : "Not yet"}
          </Badge>
        </dd>
      </dl>

      <form className="stack" onSubmit={submit}>
        {custom ? (
          <>
            <Field id={`${baseId}-mode`} label="How requests are decided">
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
                    {mode === "manual" ? " (strictest)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <p className="small muted">{modeHint(draft.mode)}</p>

            <Field
              id={`${baseId}-authority`}
              label="What the AI helper may decide"
            >
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
                    {authority === "recommend" ? " (safest)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <p className="small muted">{authorityHint(draft.authority)}</p>
          </>
        ) : null}

        <details className="advanced">
          <summary>Advanced</summary>
          <div className="stack">
            <p className="small muted">
              The address and model name only matter when the AI helper answers.
              The key is kept in your encrypted vault. It is never shown here.
            </p>
            <div className="stack">
              <p>
                <strong>AI helper:</strong> {statusSentence(reviewer)}
              </p>
              <div className="row">
                <button
                  type="button"
                  onClick={onConnectHelper}
                  disabled={onConnectHelper === undefined}
                >
                  {reviewer.ready ? "Change AI helper" : "Connect AI helper"}
                </button>
                {reviewer.keySource === "vault" ? (
                  <ForgetKey
                    onForgotten={(next) => {
                      setView(next);
                      setDraft(draftOf(next));
                    }}
                  />
                ) : null}
              </div>
            </div>
            <dl>
              <dt>Current provider</dt>
              <dd>{providerLabel(reviewer.provider)}</dd>
              <dt>Current address</dt>
              <dd>
                {reviewer.endpoint === undefined
                  ? "None. You decide every request that needs a judgment."
                  : `${reviewer.endpoint} (only the web address is shown). Requests it checks leave this computer.`}
              </dd>
              <dt>Current model</dt>
              <dd>{reviewer.model ?? "Not set"}</dd>
              <dt>API key</dt>
              <dd>
                <Badge
                  tone={reviewer.keySource === "none" ? "neutral" : "good"}
                >
                  {keySourceLabel(reviewer.keySource, reviewer.keyLocked)}
                </Badge>
              </dd>
            </dl>
            <Field
              id={`${baseId}-endpoint`}
              label="AI helper address (endpoint)"
              hint="blank keeps the current one"
            >
              <input
                id={`${baseId}-endpoint`}
                type="url"
                autoComplete="off"
                placeholder="https://ai-helper.example.test/v1"
                value={draft.endpoint}
                disabled={draft.clearEndpoint}
                onChange={(event) =>
                  setDraft({ ...draft, endpoint: event.target.value })
                }
              />
            </Field>
            {reviewer.endpoint !== undefined ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.clearEndpoint}
                  onChange={(event) =>
                    setDraft({ ...draft, clearEndpoint: event.target.checked })
                  }
                />
                Remove the address
              </label>
            ) : null}
            <Field
              id={`${baseId}-model`}
              label="AI model name"
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
          </div>
        </details>

        {needsPassword ? (
          <Notice tone="warn">
            This change needs your owner password. It gives the AI helper more
            say, turns on letting it decide, or sends its checks to a new
            address. Nothing has changed yet.
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
            {needsPassword ? "Confirm and save" : "Save changes"}
          </button>
        </div>
        {!change && !busy ? (
          <p className="small muted" role="note">
            Change the address, the model or the setting above to save.
          </p>
        ) : null}
      </form>
    </div>
  );
}
