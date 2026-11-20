// Permissions, in plain questions: who can do what on your machines, when homectl
// asks you first, and the rules you saved. Technical names and numbers are under
// Details and "Why?". Reads change nothing. Changing the setting, or removing a
// rule, needs the owner password again, because each changes what assistants may
// do.
import { Fragment, useEffect, useId, useState } from "react";
import {
  type ClientView,
  describeError,
  ownerCall,
  type PolicyDocument,
  type PolicyRule,
} from "./api";
import { AutoModeSection } from "./auto-mode";
import { readAutoMode } from "./auto-mode-api";
import {
  effectLabel,
  PRESETS,
  type PresetId,
  presetLabel,
  RISK_LEVELS,
  WORDS,
} from "./permissions-copy";
import { ruleCovers, ruleFacts, ruleOwner } from "./policy-sentences";
import { CheckRules, namesOf, WhoCanDo } from "./policy-who";
import { Badge, Dialog, Field, fmtTime, Notice, PasswordStep } from "./ui";

export function PolicyScreen({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [policy, setPolicy] = useState<PolicyDocument | undefined>();
  const [clients, setClients] = useState<ClientView[]>([]);
  const [reviewerReady, setReviewerReady] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PolicyRule | undefined>();
  const [password, setPassword] = useState("");

  const load = async () => {
    try {
      const [loaded, listed, auto] = await Promise.all([
        ownerCall<PolicyDocument>("/v1/owner/policy/get"),
        ownerCall<ClientView[]>("/v1/owner/clients/list"),
        // A read. If the AI helper's status cannot be read, the sentences assume
        // it is not ready, so they never promise a decision by the helper.
        readAutoMode().catch(() => undefined),
      ]);
      setPolicy(loaded);
      setClients(listed);
      setReviewerReady(auto?.reviewer.ready === true);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  // Runs one change that needs the password. The field is cleared first.
  const change = async (
    path: string,
    body: Record<string, unknown>,
    done: string,
  ) => {
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      setPolicy(
        await ownerCall<PolicyDocument>(path, { ...body, password: secret }),
      );
      setNotice(done);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!policy)
    return error ? (
      <Notice tone="bad">{error}</Notice>
    ) : (
      <p className="muted">Loading…</p>
    );

  const names = namesOf(clients);

  return (
    <>
      <div className="page-head">
        <h2>Permissions</h2>
        <p>
          Permissions decide what your assistants may do on your machines, and
          when homectl asks you first. A change applies to the next request.
        </p>
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {notice ? <Notice tone="good">{notice}</Notice> : null}

      <section aria-labelledby="who-title">
        <h3 id="who-title">Who can do what on your machines?</h3>
        <WhoCanDo
          policy={policy}
          clients={clients}
          reviewerReady={reviewerReady}
        />
      </section>

      <section aria-labelledby="ask-title">
        <h3 id="ask-title">When does homectl ask you first?</h3>
        <ul className="plain-list">
          <li>
            <strong>Looking around</strong> (checking things, changing nothing):
            no question, unless a rule blocks it or your setting asks you about
            every request.
          </li>
          <li>
            <strong>Small, undoable changes</strong>: homectl asks you, unless
            one of your rules covers it or the AI helper decides it (if you
            turned that on).
          </li>
          <li>
            <strong>Big or risky changes</strong>, and commands homectl cannot
            identify: homectl asks you and needs your owner password. Only a
            saved rule that covers it lets it run without asking.
          </li>
          <li>
            <strong>Destructive changes</strong>, and anything that changes who
            is trusted or copies out passwords or keys: homectl always asks you
            with your owner password. No rule and no AI helper can approve
            these.
          </li>
          <li>
            <strong>Too many changes in a short time</strong>: homectl asks you
            before it goes on.
          </li>
        </ul>
        <h4>How much should homectl decide for you?</h4>
        <PresetChooser
          currentId={presetOf(policy)}
          password={password}
          onPassword={setPassword}
          busy={busy}
          onApply={(preset) =>
            change(
              "/v1/owner/policy/preset",
              { preset },
              `Changed to "${presetLabel(preset)}".`,
            )
          }
        />
      </section>

      <section aria-labelledby="rules-title">
        <h3 id="rules-title">Rules ({policy.rules.length})</h3>
        <p className="small muted">
          A rule decides matching requests without asking you again. Some come
          with homectl; others you saved from your answers.
        </p>
        <table className="stackable">
          <thead>
            <tr>
              <th>What it covers</th>
              <th>Result</th>
              <th className="hide-sm">Saved by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {policy.rules.map((rule) => (
              <tr key={rule.id}>
                <td>
                  {ruleCovers(rule, names)}
                  <details className="why">
                    <summary>Why?</summary>
                    <dl>
                      <dt>Rule ID</dt>
                      <dd className="mono">{rule.id}</dd>
                      <dt>Stored effect</dt>
                      <dd className="mono">{rule.effect}</dd>
                      {ruleFacts(rule, names).map((fact) => (
                        <Fragment key={fact.key}>
                          <dt>{fact.term}</dt>
                          <dd>
                            {fact.value}
                            <div className="small muted">
                              {fact.meaning} Stored as {fact.key}.
                            </div>
                          </dd>
                        </Fragment>
                      ))}
                      {rule.note ? (
                        <>
                          <dt>Note</dt>
                          <dd>{rule.note}</dd>
                        </>
                      ) : null}
                      <dt>Saved</dt>
                      <dd>{fmtTime(rule.createdAt)}</dd>
                    </dl>
                  </details>
                </td>
                <td>
                  <Badge
                    tone={
                      rule.effect === "deny"
                        ? "bad"
                        : rule.effect === "allow"
                          ? "good"
                          : "warn"
                    }
                  >
                    {effectLabel(rule.effect)}
                  </Badge>
                </td>
                <td className="hide-sm small">{ruleOwner(rule)}</td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => setRemoving(rule)}
                  >
                    Remove…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {policy.rules.length === 0 ? (
          <p className="muted">
            No rules yet. Each request is decided by your setting, and you
            answer it when homectl asks.
          </p>
        ) : null}
      </section>

      <AutoModeSection onError={onError} onSaved={load} />

      <section aria-labelledby="details-title">
        <details className="details">
          <summary id="details-title">Details</summary>
          <div className="stack">
            <h4>Risk levels</h4>
            <p className="small muted">
              Each command gets one of these levels. Higher levels need you more
              often.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Level</th>
                  <th>What it means</th>
                </tr>
              </thead>
              <tbody>
                {RISK_LEVELS.map((risk) => (
                  <tr key={risk.level}>
                    <td>
                      <span className="mono">{risk.level}</span>
                    </td>
                    <td>{risk.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4>Limits (budgets)</h4>
            <p className="small">
              An assistant may make up to {policy.budgets.clientMaxRiskPoints}{" "}
              risk points in{" "}
              {Math.round(policy.budgets.clientWindowMs / 60_000)} minutes. A
              task may make up to {policy.budgets.taskMaxOperations} operations
              and {policy.budgets.taskMaxRiskPoints} risk points. Going over a
              limit asks you. Each risk level counts for a different number of
              points.
            </p>

            <h4>Check one assistant on one machine</h4>
            <CheckRules
              clients={clients}
              rules={policy.rules}
              onError={onError}
            />

            <h4>Words used on this page</h4>
            <dl>
              {WORDS.map((word) => (
                <Fragment key={word.term}>
                  <dt>{word.term}</dt>
                  <dd>{word.meaning}</dd>
                </Fragment>
              ))}
            </dl>

            <h4>Technical values</h4>
            <dl>
              <dt>Revision</dt>
              <dd>{policy.revision}</dd>
              <dt>Stored setting</dt>
              <dd>
                mode {policy.mode}; the AI helper&apos;s authority{" "}
                {policy.reviewer.authority}
              </dd>
              <dt>Highest level the AI helper may decide</dt>
              <dd>{policy.reviewer.maxRisk}</dd>
              <dt>When the AI helper is unsure</dt>
              <dd>
                {policy.reviewer.fallback === "ask"
                  ? "Asks you (fallback: ask)"
                  : `${policy.reviewer.fallback} (fallback)`}
              </dd>
            </dl>
          </div>
        </details>
      </section>

      {removing ? (
        <Dialog
          title="Remove this rule?"
          onClose={() => setRemoving(undefined)}
        >
          <p>{ruleCovers(removing, names)}</p>
          <p>Requests it covered will be decided again from the start.</p>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to remove"
          />
          <div className="row">
            <button
              type="button"
              className="danger"
              disabled={!password || busy}
              onClick={() => {
                const rule = removing;
                setRemoving(undefined);
                void change(
                  "/v1/owner/policy/remove-rule",
                  { id: rule.id },
                  "Rule removed.",
                );
              }}
            >
              Remove rule
            </button>
            <button type="button" onClick={() => setRemoving(undefined)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function presetOf(policy: PolicyDocument): PresetId | undefined {
  if (policy.mode === "auto" && policy.reviewer.authority === "delegated")
    return "delegated";
  if (policy.mode === "rules" && policy.reviewer.authority === "routine")
    return "routine";
  if (policy.mode === "rules" && policy.reviewer.authority === "recommend")
    return "conservative";
  return undefined;
}

function PresetChooser({
  currentId,
  password,
  onPassword,
  busy,
  onApply,
}: {
  currentId: PresetId | undefined;
  password: string;
  onPassword: (value: string) => void;
  busy: boolean;
  onApply: (preset: PresetId) => void;
}) {
  const [choice, setChoice] = useState<PresetId | undefined>();
  const baseId = useId();
  const target = choice ?? currentId;
  const hint = PRESETS.find((preset) => preset.id === target)?.hint;
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (target && target !== currentId) onApply(target);
      }}
    >
      <p className="small">
        Current setting:{" "}
        <strong>
          {currentId === undefined
            ? "Custom (set under Let an AI helper decide)"
            : presetLabel(currentId)}
        </strong>
      </p>
      <Field id={`${baseId}-preset`} label="Choose a setting">
        <select
          id={`${baseId}-preset`}
          value={target ?? ""}
          onChange={(event) =>
            setChoice((event.target.value || undefined) as PresetId | undefined)
          }
        >
          {currentId === undefined ? (
            <option value="">Custom (set under Let an AI helper decide)</option>
          ) : null}
          {PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </Field>
      {hint ? <p className="small muted">{hint}</p> : null}
      {target && target !== currentId ? (
        <>
          <p className="small muted">
            Changing this needs your owner password.
          </p>
          <PasswordStep
            value={password}
            onChange={onPassword}
            hint="required to change"
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !password}
          >
            Change setting
          </button>
        </>
      ) : null}
    </form>
  );
}
