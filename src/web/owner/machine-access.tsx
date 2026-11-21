// The access level as a plain choice: one row per level, each with its sentence.
// The admin commands are a field of their own, shown only for "Admin with your
// approval". A root login is locked to Full admin, with the warning beside it.
import { useId } from "react";
import { ACCESS_TIERS, ROOT_WARNING } from "./machine-words";
import type { AccessTier } from "./machine-api";
import { RadioRow } from "./radio";
import { Field, Notice } from "./ui";
import type { ReactNode } from "react";

export function AccessPicker({
  value,
  onChange,
  lockedToFull = false,
  disabled = false,
}: {
  value: AccessTier;
  onChange: (value: AccessTier) => void;
  // A root login: only Full admin is possible.
  lockedToFull?: boolean;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="plain-fieldset" disabled={disabled}>
      <legend className="sub-title">Access level</legend>
      <p className="small muted">
        Look only is the default. Raise it only when a task needs more.
      </p>
      {lockedToFull ? <Notice tone="warn">{ROOT_WARNING}</Notice> : null}
      <div className="radio-group">
        {ACCESS_TIERS.map((tier) => (
          <RadioRow
            key={tier.id}
            name={name}
            value={tier.id}
            checked={value === tier.id}
            disabled={lockedToFull && tier.id !== "full"}
            onChange={() => onChange(tier.id)}
            title={tier.label}
            detail={tier.sentence}
          />
        ))}
      </div>
    </fieldset>
  );
}

// One allowed admin command per line. The commands are checked by the broker
// too; this field only says what the next step needs.
export function CommandsField({
  value,
  onChange,
  problem,
}: {
  value: string;
  onChange: (value: string) => void;
  problem?: string | undefined;
}): ReactNode {
  const id = useId();
  return (
    <Field
      id={id}
      label="Allowed admin commands"
      hint="one per line, with the full path"
    >
      <textarea
        id={id}
        rows={4}
        spellCheck={false}
        className="mono"
        placeholder={"/usr/bin/systemctl restart nas"}
        value={value}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : `${id}-help`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-help`} className="small muted">
        Each command runs only if it matches one of these lines exactly.
      </p>
      {problem ? (
        <p id={`${id}-problem`} className="small problem" role="alert">
          {problem}
        </p>
      ) : null}
    </Field>
  );
}
