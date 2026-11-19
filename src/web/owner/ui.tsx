// Small presentational pieces shared by the owner screens. Requester text is
// always rendered through Untrusted, as plain text with a visible label.
import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";

export type Tone = "neutral" | "warn" | "bad" | "good" | "count";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const className = tone === "neutral" ? "badge" : `badge ${tone}`;
  return <span className={className}>{children}</span>;
}

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "bad" | "good";
  children: ReactNode;
}) {
  const className = tone === "neutral" ? "notice" : `notice ${tone}`;
  return (
    <div className={className} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </div>
  );
}

// Argv as one chip per token, so spaces and quotes stay visible.
export function Argv({ argv }: { argv: string[] }) {
  return (
    <div className="chips" aria-label="Command arguments">
      {argv.map((token, index) => (
        <span className="chip" key={`${index}-${token}`}>
          {token === "" ? '""' : token}
        </span>
      ))}
    </div>
  );
}

export function Untrusted({
  label = "Written by the agent",
  text,
}: {
  label?: string;
  text: string | undefined;
}) {
  if (!text) return null;
  return (
    <div className="untrusted">
      <div className="label">{label} · not verified</div>
      <p>{text}</p>
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {hint ? <span className="hint"> · {hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

// The owner password for step-up. The parent owns the value and clears it
// after every submit, so it never outlives the request.
export function PasswordStep({
  value,
  onChange,
  label = "Owner password",
  hint = "confirm this change",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <Field id={id} label={label} hint={hint}>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("button, input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function fmtTime(value: number | string | undefined): string {
  if (value === undefined) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

export function minutesLeft(expiresAt: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  return minutes <= 1 ? "less than a minute" : `${minutes} minutes`;
}
