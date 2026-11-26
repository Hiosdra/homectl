// A one-time code shown the way a phone pairing screen shows one: one large code,
// the time left in plain words, and the steps for the other device. The code lives
// only in the component that shows it; it is hidden once it has expired.
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { spanOf } from "./time";
import { fmtTime, Notice } from "./ui";

// The current time, refreshed each second so the countdown stays honest.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function PairCode({
  code,
  expiresAt,
  title,
  codeLabel,
  steps,
  expiredText,
  expiredLabel,
  doneLabel,
  onDone,
  onExpired,
  children,
}: {
  code: string;
  // Epoch milliseconds.
  expiresAt: number;
  title: string;
  codeLabel: string;
  steps: ReactNode;
  expiredText: string;
  expiredLabel: string;
  doneLabel: string;
  onDone: () => void;
  onExpired?: () => void;
  children?: ReactNode;
}) {
  const now = useNow();
  const left = expiresAt - now;
  const expired = left <= 0;
  return (
    <div className="stack pair">
      {expired ? (
        <Notice tone="warn">{expiredText}</Notice>
      ) : (
        <>
          <div className="pair-card">
            <p className="pair-title">{title}</p>
            <p className="pair-code" aria-label={codeLabel}>
              {code}
            </p>
            <p className="pair-timer">
              Expires in {spanOf(left)}. It works once.
            </p>
          </div>
          {steps}
        </>
      )}
      {children}
      <details className="details">
        <summary>Details</summary>
        <dl>
          <dt>Code expires</dt>
          <dd>{fmtTime(expiresAt)}</dd>
        </dl>
      </details>
      <div className="row">
        <button
          type="button"
          className={expired ? "primary" : undefined}
          onClick={expired ? (onExpired ?? onDone) : onDone}
        >
          {expired ? expiredLabel : doneLabel}
        </button>
        {expired && onExpired ? (
          <button type="button" onClick={onDone}>
            Close
          </button>
        ) : null}
      </div>
    </div>
  );
}
