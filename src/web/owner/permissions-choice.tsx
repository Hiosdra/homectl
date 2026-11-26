// "How much should homectl decide?": the one control for how requests are decided.
// Three large choices, each with its consequence in one line. Choosing a different
// one needs the owner password, as the broker requires. A setting that matches none
// of the three is shown as Custom; it is changed under the AI helper's Advanced
// settings, never here.
import { useId } from "react";
import { PRESETS, type PresetId, presetLabel } from "./permissions-copy";
import { RadioRow } from "./radio";
import { PasswordStep } from "./ui";

export function ModeChooser({
  currentId,
  choice,
  onChoice,
  password,
  onPassword,
  busy,
  onApply,
}: {
  currentId: PresetId | undefined;
  choice: PresetId | undefined;
  onChoice: (choice: PresetId) => void;
  password: string;
  onPassword: (value: string) => void;
  busy: boolean;
  onApply: (preset: PresetId) => void;
}) {
  const baseId = useId();
  const target = choice ?? currentId;
  const pending = target !== undefined && target !== currentId;
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (target && pending && password.length > 0) onApply(target);
      }}
    >
      <fieldset>
        <legend className="sr-only">How much should homectl decide?</legend>
        <div className="radio-group">
          {PRESETS.map((preset) => (
            <RadioRow
              key={preset.id}
              name={`${baseId}-mode`}
              value={preset.id}
              checked={target === preset.id}
              onChange={() => onChoice(preset.id)}
              title={preset.label}
              detail={preset.detail}
            />
          ))}
          {currentId === undefined ? (
            <RadioRow
              name={`${baseId}-mode`}
              value="custom"
              checked
              disabled
              onChange={() => undefined}
              title="Custom"
              detail="Your setting differs from the three choices. Change it under the AI helper's Advanced settings below."
            />
          ) : null}
        </div>
      </fieldset>
      <p className="small muted">
        Saved now:{" "}
        <strong>
          {currentId === undefined ? "Custom" : presetLabel(currentId)}
        </strong>
      </p>
      {pending ? (
        <>
          <PasswordStep
            value={password}
            onChange={onPassword}
            hint="required to change"
          />
          <div className="request-actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || password.length === 0}
            >
              Save this setting
            </button>
          </div>
          {password.length === 0 && !busy ? (
            <p className="small muted" role="note">
              Enter your owner password to save this setting.
            </p>
          ) : null}
        </>
      ) : null}
    </form>
  );
}
