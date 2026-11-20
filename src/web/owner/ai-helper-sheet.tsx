// "Connect your AI helper": the onboarding the owner sees when they choose an AI
// setting but no helper is set up yet. Nothing is saved until the last step, and
// Cancel leaves the previous setting as it was. On a phone it fills the screen.
import { useState } from "react";
import { describeError } from "./api";
import {
  connectAiHelper,
  listAiModels,
  type ModelList,
  type ProviderForm,
  testAiHelper,
} from "./ai-helper-api";
import {
  CONFIRM_HELP,
  CUSTOM_BASE_EXAMPLE,
  ENVIRONMENT_KEY_NOTE,
  KEY_HELP,
  LOCKED_NOTE,
  PROVIDER_CHOICES,
  PROVIDER_HELP,
  READY_TEXT,
  SHEET_INTRO,
  SHEET_TITLE,
  statusSentence,
  TEST_HELP,
} from "./ai-helper-copy";
import { ForgetKey } from "./ai-helper-forget";
import { ModelPicker } from "./ai-helper-models";
import {
  type AiProviderId,
  type AutoModeView,
  needsOwnerPassword,
} from "./auto-mode-api";
import { presetLabel } from "./permissions-copy";
import { Badge, Dialog, Field, Notice, PasswordStep } from "./ui";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

export function AiHelperSheet({
  preset,
  initial,
  onCancel,
  onConnected,
}: {
  // The Permissions choice the owner picked; undefined from Advanced.
  preset?: "routine" | "delegated";
  initial: AutoModeView;
  onCancel: () => void;
  onConnected: (view: AutoModeView) => void;
}) {
  const [view, setView] = useState(initial);
  const [form, setForm] = useState<ProviderForm>(() => ({
    provider: initial.reviewer.provider ?? "anthropic",
    baseUrl: "",
    apiKey: "",
    model:
      initial.reviewer.model ??
      ((initial.reviewer.provider ?? "anthropic") === "anthropic"
        ? DEFAULT_ANTHROPIC_MODEL
        : ""),
  }));
  // A saved key is kept unless the owner asks to replace it.
  const [replacing, setReplacing] = useState(false);
  const [list, setList] = useState<ModelList | undefined>();
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | undefined>();
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const keySource = view.reviewer.keySource;
  const custom = form.provider === "custom";
  const keyHint =
    PROVIDER_CHOICES.find((item) => item.id === form.provider)?.keyHint ?? "";

  // Any change to what is tested means the test must run again.
  const update = (patch: Partial<ProviderForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setTest({ kind: "idle" });
  };

  const chooseProvider = (provider: AiProviderId) => {
    setList(undefined);
    setListError(undefined);
    update({
      provider,
      model:
        provider === "anthropic" && form.model.length === 0
          ? DEFAULT_ANTHROPIC_MODEL
          : provider === form.provider
            ? form.model
            : "",
    });
  };

  const refresh = async () => {
    setListLoading(true);
    setListError(undefined);
    try {
      setList(await listAiModels(form));
    } catch (failure) {
      setList(undefined);
      setListError(describeError(failure));
    } finally {
      setListLoading(false);
    }
  };

  const runTest = async () => {
    if (form.model.length === 0) {
      setTest({ kind: "failed", message: "Choose a model first." });
      return;
    }
    setTest({ kind: "testing" });
    try {
      await testAiHelper(form);
      setTest({ kind: "ready" });
    } catch (failure) {
      setTest({ kind: "failed", message: describeError(failure) });
    }
  };

  const connect = async () => {
    if (busy || password.length === 0 || test.kind !== "ready") return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      const saved = await connectAiHelper({
        ...form,
        ...(preset === undefined ? {} : { preset }),
        password: secret,
      });
      onConnected(saved);
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

  const canConnect =
    test.kind === "ready" &&
    password.length > 0 &&
    form.model.length > 0 &&
    !busy;

  return (
    <Dialog title={SHEET_TITLE} onClose={onCancel} className="ai-helper-sheet">
      <div className="stack">
        <p className="small muted">{SHEET_INTRO}</p>
        {preset !== undefined ? (
          <p className="small">
            Setting to save: <strong>{presetLabel(preset)}</strong>. Nothing
            changes until you connect.
          </p>
        ) : null}
        <p className="small">
          Now: <span>{statusSentence(view.reviewer)}</span>
        </p>
        {view.reviewer.keyLocked ? (
          <Notice tone="warn">{LOCKED_NOTE}</Notice>
        ) : null}

        <section aria-labelledby="ai-provider-title">
          <h3 id="ai-provider-title">1. Provider</h3>
          <p className="small muted">{PROVIDER_HELP}</p>
          <div className="segmented" role="radiogroup" aria-label="Provider">
            {PROVIDER_CHOICES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={form.provider === item.id}
                className={form.provider === item.id ? "on" : undefined}
                onClick={() => chooseProvider(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="ai-key-title">
          <h3 id="ai-key-title">2. API key</h3>
          {keySource === "environment" ? (
            <Notice tone="good">{ENVIRONMENT_KEY_NOTE}</Notice>
          ) : null}
          {keySource === "vault" && !replacing ? (
            <div className="stack">
              <div className="row">
                <Badge tone="good">A key is saved</Badge>
              </div>
              <div className="row">
                <button type="button" onClick={() => setReplacing(true)}>
                  Replace key…
                </button>
                <ForgetKey
                  onForgotten={(next) => {
                    setView(next);
                    setReplacing(false);
                    setTest({ kind: "idle" });
                  }}
                />
              </div>
            </div>
          ) : null}
          {keySource !== "environment" &&
          (keySource !== "vault" || replacing) ? (
            <>
              <p className="small muted">
                {custom ? "Optional for most local servers. " : ""}
                {KEY_HELP}
              </p>
              <Field id="ai-key" label="API key" hint={keyHint}>
                <input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.apiKey}
                  onChange={(event) => update({ apiKey: event.target.value })}
                />
              </Field>
            </>
          ) : null}
        </section>

        {custom ? (
          <section aria-labelledby="ai-base-title">
            <h3 id="ai-base-title">3. Address</h3>
            <Field
              id="ai-base"
              label="Base URL"
              hint={`for example ${CUSTOM_BASE_EXAMPLE}`}
            >
              <input
                id="ai-base"
                type="url"
                autoComplete="off"
                placeholder={CUSTOM_BASE_EXAMPLE}
                value={form.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
            </Field>
          </section>
        ) : null}

        <section aria-labelledby="ai-model-title">
          <h3 id="ai-model-title">{custom ? "4" : "3"}. Model</h3>
          <ModelPicker
            list={list}
            loading={listLoading}
            error={listError}
            selected={form.model}
            onSelect={(model) => update({ model })}
            onRefresh={() => void refresh()}
          />
        </section>

        <section aria-labelledby="ai-test-title">
          <h3 id="ai-test-title">{custom ? "5" : "4"}. Test</h3>
          <p className="small muted">{TEST_HELP}</p>
          <div className="row">
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={test.kind === "testing"}
            >
              {test.kind === "testing" ? "Testing…" : "Test the connection"}
            </button>
          </div>
          {test.kind === "ready" ? (
            <Notice tone="good">{READY_TEXT}</Notice>
          ) : null}
          {test.kind === "failed" ? (
            <Notice tone="bad">{test.message}</Notice>
          ) : null}
        </section>

        <section aria-labelledby="ai-confirm-title">
          <h3 id="ai-confirm-title">{custom ? "6" : "5"}. Confirm</h3>
          <p className="small muted">{CONFIRM_HELP}</p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <PasswordStep value={password} onChange={setPassword} />
            {error ? <Notice tone="bad">{error}</Notice> : null}
            <div className="row sheet-actions">
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!canConnect}>
                Connect
              </button>
            </div>
            {test.kind !== "ready" ? (
              <p className="small muted" role="note">
                Run the test first. Then you can connect.
              </p>
            ) : null}
          </form>
        </section>
      </div>
    </Dialog>
  );
}
