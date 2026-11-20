// Small presentational pieces shared by the owner screens. Requester text is
// always rendered through Untrusted, as plain text with a visible label.
import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { Icon, type IconName } from "./icons";

export type Tone = "neutral" | "info" | "warn" | "bad" | "good" | "count";

// A badge always says its meaning in words; the optional icon repeats it, so
// colour is never the only signal.
export function Badge({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
}) {
  const className = tone === "neutral" ? "badge" : `badge ${tone}`;
  return (
    <span className={className}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}

const NOTICE_ICON: Record<"neutral" | "warn" | "bad" | "good", IconName> = {
  neutral: "info",
  warn: "alert",
  bad: "alert",
  good: "check-circle",
};

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn" | "bad" | "good";
  children: ReactNode;
}) {
  const className = tone === "neutral" ? "notice" : `notice ${tone}`;
  // Errors interrupt (alert); everything else is announced politely (status).
  return (
    <div className={className} role={tone === "bad" ? "alert" : "status"}>
      <Icon name={NOTICE_ICON[tone]} />
      <div className="notice-body">{children}</div>
    </div>
  );
}

// A transient result after an action. It stays for a while so it can be read, then
// clears itself; Dismiss clears it at once. It never blocks the list underneath
// for longer than that, and the screen keeps its own result text too.
export const TOAST_MS = 8_000;

export function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  // The timer restarts only for a new message, not on every re-render.
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    const timer = setTimeout(() => latest.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <div className="toast" role="status">
      <p>{message}</p>
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
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

// A machine's inventory name, set as a chip wherever it sits. The name itself is
// never changed, so "nas" reads the same on every screen.
export function MachineChip({ name }: { name: string }) {
  return <span className="machine">{name}</span>;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A sentence that names machines: each whole-word match is set as a MachineChip, and
// the rest of the sentence stays plain text.
export function MachineText({
  text,
  machines,
}: {
  text: string;
  machines: readonly string[];
}) {
  const names = [...new Set(machines.filter((name) => name !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return <>{text}</>;
  const pattern = new RegExp(
    `\\b(${names.map(escapeForPattern).join("|")})\\b`,
  );
  // With one capture group, split puts each machine name at an odd index.
  return (
    <>
      {text
        .split(pattern)
        .map((part, index) =>
          index % 2 === 1 ? (
            <MachineChip key={`${index}-${part}`} name={part} />
          ) : (
            part
          ),
        )}
    </>
  );
}

export function Untrusted({
  label = "Written by the assistant",
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
