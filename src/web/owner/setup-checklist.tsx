// The setup checklist at the top of Needs you (audit B4), the upgrade notice, and the
// links the empty states use to reach a setup step (audit B5). It never counts toward
// the nav attention badge: only real approvals and secret requests do.
import { useState } from "react";
import { CopyButton } from "./copy";
import { Icon } from "./icons";
import { setupHash } from "./route";
import {
  markSetup,
  type SetupPath,
  type SetupStatus,
  type SetupStepId,
} from "./setup-api";
import { PathSwitch } from "./setup-path";
import {
  progressLine,
  stateTone,
  stateWord,
  UPGRADE_LINE,
  UPGRADE_TITLE,
  WIZARD_STEPS,
  wizardStep,
} from "./setup-copy";
import { Badge } from "./ui";

// A link into a setup step, for the empty states ("Add a machine first →").
export function SetupLink({
  step,
  children,
}: {
  step?: SetupStepId;
  children: string;
}) {
  return (
    <a className="setup-link" href={setupHash(step)}>
      {children}
    </a>
  );
}

// Shown until the owner acknowledges it. The broker sets it only after a migration
// actually ran, so a normal start never shows it.
export function UpgradeNotice({
  status,
  onChanged,
  onError,
}: {
  status: SetupStatus;
  onChanged: (next: SetupStatus) => void;
  onError: (error: unknown) => unknown;
}) {
  const [busy, setBusy] = useState(false);
  if (!status.upgrade || status.upgrade.acknowledged) return null;
  const acknowledge = async () => {
    setBusy(true);
    try {
      onChanged(await markSetup({ action: "upgrade-ack" }));
    } catch (failure) {
      onError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="upgrade-notice" aria-labelledby="upgrade-title">
      <h3 id="upgrade-title">{UPGRADE_TITLE}</h3>
      <p>{UPGRADE_LINE}</p>
      <div className="row">
        <a className="button" href="#/agents">
          Open Assistants
        </a>
        <button type="button" onClick={acknowledge} disabled={busy}>
          Got it
        </button>
      </div>
    </section>
  );
}

export function SetupChecklist({
  status,
  onOpen,
  onChanged,
  onError,
  switchTo,
}: {
  status: SetupStatus;
  onOpen: (hash: string) => void;
  onChanged: (next: SetupStatus) => void;
  onError: (error: unknown) => unknown;
  // The path the link offers. Defaults to the other path than the one chosen.
  switchTo?: SetupPath;
}) {
  const [busy, setBusy] = useState(false);
  // Hidden once the owner dismisses the checklist (setup stays reachable in System).
  if (status.dismissed) return null;

  const dismiss = async () => {
    setBusy(true);
    try {
      onChanged(await markSetup({ action: "dismiss" }));
    } catch (failure) {
      onError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (status.completed)
    return (
      <section className="setup-collapsed" aria-label="Setup">
        <p>
          <Icon name="check-circle" /> <strong>You're set up.</strong> Your
          checklist is saved.{" "}
          <a href={setupHash()} className="setup-link">
            Review setup
          </a>
        </p>
        <button type="button" onClick={dismiss} disabled={busy}>
          Hide this
        </button>
      </section>
    );

  const next = status.next ? wizardStep(status.next) : undefined;
  return (
    <section
      className="setup-checklist"
      aria-labelledby="setup-checklist-title"
    >
      <div className="row between">
        <h3 id="setup-checklist-title">Finish setup</h3>
        <Badge tone="neutral">{progressLine(status)}</Badge>
      </div>
      <p className="small muted">
        Each step opens a short page. Skip a step to come back to it later.
      </p>
      <ol className="setup-list">
        {WIZARD_STEPS.filter(
          (step) => step.id !== "welcome" && step.id !== "done",
        ).map((step) => {
          const item = status.steps.find((entry) => entry.id === step.id);
          if (!item) return null;
          const word = stateWord(item, status.next);
          return (
            <li key={step.id} className="setup-list-item">
              <span className="setup-list-name">{step.title}</span>
              <Badge tone={stateTone(item.state)}>{word}</Badge>
              <a
                className="setup-link"
                href={setupHash(step.id)}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(setupHash(step.id));
                }}
                aria-label={`Open: ${step.title}`}
              >
                Open
              </a>
            </li>
          );
        })}
      </ol>
      <div className="row">
        {next ? (
          <button
            type="button"
            className="primary"
            onClick={() => onOpen(setupHash(next.id))}
          >
            Continue setup
          </button>
        ) : null}
        <button type="button" onClick={dismiss} disabled={busy}>
          Hide for now
        </button>
        {next ? <span className="small muted">Next: {next.title}</span> : null}
      </div>
      <p className="path-switch-line">
        <PathSwitch
          to={switchTo ?? (status.path === "agent" ? "manual" : "agent")}
          status={status}
          onChanged={onChanged}
          onGo={onOpen}
          onError={onError}
        />
      </p>
    </section>
  );
}

// The setup copy for a single machine or assistant hint. A copyable command is
// always beside the words, so the owner never has to retype it.
export function TerminalHint({
  label,
  command,
  note,
}: {
  label: string;
  command: string;
  note?: string;
}) {
  return (
    <div className="setup-command">
      <code>{command}</code>
      <CopyButton label={label} text={command} />
      {note ? <p className="small muted">{note}</p> : null}
    </div>
  );
}
