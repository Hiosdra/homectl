// Effective permissions: what the policy allows right now, rule by rule. Reads
// change nothing. Switching the preset and removing a rule each need the owner
// password again, because both change what agents may do.
import { useEffect, useId, useState } from "react";
import {
  type EffectiveView,
  describeError,
  type PolicyDocument,
  type PolicyRule,
  ownerCall,
} from "./api";
import { Badge, Dialog, Field, Notice, PasswordStep, fmtTime } from "./ui";

const PRESETS: { id: string; label: string; hint: string }[] = [
  {
    id: "conservative",
    label: "Recommend only",
    hint: "Manual decisions for everything except built-in safe reads. The reviewer only suggests.",
  },
  {
    id: "routine",
    label: "Routine maintenance",
    hint: "The reviewer may also decide routine, reversible maintenance within the risk limit.",
  },
  {
    id: "delegated",
    label: "Wider delegation",
    hint: "Auto mode: the reviewer decides eligible requests within explicit delegated scope. Hard gates still apply.",
  },
];

function describeMatch(match: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(match)) {
    if (Array.isArray(value)) parts.push(`${key}: ${value.join(", ")}`);
    else if (value !== undefined) parts.push(`${key}: ${String(value)}`);
  }
  return parts.join(" · ") || "any request";
}

export function PolicyScreen({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [policy, setPolicy] = useState<PolicyDocument | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PolicyRule | undefined>();
  const [password, setPassword] = useState("");

  const load = async () => {
    try {
      setPolicy(await ownerCall<PolicyDocument>("/v1/owner/policy/get"));
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
    return error ? <Notice tone="bad">{error}</Notice> : <p className="muted">Loading…</p>;

  const currentPreset = PRESETS.find(
    (preset) => preset.id === presetOf(policy),
  );

  return (
    <>
      <h2>Permissions</h2>
      <p className="small muted">
        This is what agents may do under the current rules (revision{" "}
        {policy.revision}). Changes apply to the next request.
      </p>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {notice ? <Notice tone="good">{notice}</Notice> : null}

      <section aria-labelledby="mode-title">
        <h3 id="mode-title">Mode and reviewer</h3>
        <dl>
          <dt>Mode</dt>
          <dd>{policy.mode}</dd>
          <dt>Reviewer may</dt>
          <dd>
            {policy.reviewer.authority} · up to {policy.reviewer.maxRisk} · when
            unsure: {policy.reviewer.fallback}
          </dd>
          <dt>Budgets</dt>
          <dd>
            {policy.budgets.taskMaxOperations} operations and{" "}
            {policy.budgets.taskMaxRiskPoints} risk points per task;{" "}
            {policy.budgets.clientMaxRiskPoints} risk points per agent per{" "}
            {Math.round(policy.budgets.clientWindowMs / 60_000)} minutes
          </dd>
          <dt>Preset</dt>
          <dd>{currentPreset?.label ?? "Custom"}</dd>
        </dl>
        <PresetChooser
          currentId={currentPreset?.id}
          password={password}
          onPassword={setPassword}
          busy={busy}
          onApply={(preset) =>
            change(
              "/v1/owner/policy/preset",
              { preset },
              `Switched to ${PRESETS.find((p) => p.id === preset)?.label ?? preset}.`,
            )
          }
        />
      </section>

      <section aria-labelledby="rules-title">
        <h3 id="rules-title">Rules ({policy.rules.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Rule</th>
              <th>Effect</th>
              <th className="hide-sm">Applies to</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {policy.rules.map((rule) => (
              <tr key={rule.id}>
                <td>
                  <span className="mono">{rule.id}</span>
                  <div className="small muted">
                    {rule.note ?? ""} · {rule.createdBy} · {fmtTime(rule.createdAt)}
                  </div>
                </td>
                <td>
                  <Badge tone={rule.effect === "deny" ? "bad" : rule.effect === "allow" ? "good" : "warn"}>
                    {rule.effect}
                  </Badge>
                </td>
                <td className="hide-sm small">{describeMatch(rule.match)}</td>
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
          <p className="muted">No rules. Every request is decided one by one.</p>
        ) : null}
      </section>

      <EffectiveCheck onError={onError} />

      {removing ? (
        <Dialog title={`Remove rule ${removing.id}?`} onClose={() => setRemoving(undefined)}>
          <p>Requests it covered will be decided again from scratch.</p>
          <PasswordStep value={password} onChange={setPassword} hint="required to remove" />
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
                  `Removed ${rule.id}.`,
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

function presetOf(policy: PolicyDocument): string | undefined {
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
  currentId: string | undefined;
  password: string;
  onPassword: (value: string) => void;
  busy: boolean;
  onApply: (preset: string) => void;
}) {
  const [choice, setChoice] = useState<string | undefined>();
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
      <Field id={`${baseId}-preset`} label="Change preset">
        <select
          id={`${baseId}-preset`}
          value={target ?? ""}
          onChange={(event) => setChoice(event.target.value)}
        >
          {currentId === undefined ? <option value="">Custom</option> : null}
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
          <PasswordStep value={password} onChange={onPassword} hint="required to change" />
          <button type="submit" className="primary" disabled={busy || !password}>
            Apply preset
          </button>
        </>
      ) : null}
    </form>
  );
}

function EffectiveCheck({ onError }: { onError: (error: unknown) => unknown }) {
  const baseId = useId();
  const [client, setClient] = useState("");
  const [host, setHost] = useState("");
  const [view, setView] = useState<EffectiveView | undefined>();
  const [error, setError] = useState<string | undefined>();
  return (
    <section aria-labelledby={`${baseId}-title`}>
      <h3 id={`${baseId}-title`}>What applies to an agent on a host</h3>
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          try {
            setView(
              await ownerCall<EffectiveView>("/v1/owner/policy/explain", {
                client: client.trim(),
                ...(host.trim() ? { host: host.trim() } : {}),
              }),
            );
          } catch (failure) {
            onError(failure);
            setError(describeError(failure));
          }
        }}
      >
        <Field id={`${baseId}-client`} label="Agent identifier">
          <input id={`${baseId}-client`} required value={client} onChange={(e) => setClient(e.target.value)} />
        </Field>
        <Field id={`${baseId}-host`} label="Host" hint="optional">
          <input id={`${baseId}-host`} value={host} onChange={(e) => setHost(e.target.value)} />
        </Field>
        <button type="submit" disabled={!client.trim()}>
          Explain
        </button>
      </form>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {view ? (
        <ul className="small">
          {view.rules.map((rule) => (
            <li key={rule.ruleId}>
              <span className="mono">{rule.ruleId}</span> ({rule.effect}):{" "}
              {rule.applies ? "applies" : "does not apply"}
              {rule.reasons.length > 0 ? ` — ${rule.reasons.join("; ")}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
