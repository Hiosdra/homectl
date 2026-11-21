// The guided setup (#/setup, #/setup/<step>): a progress line, a list of the steps,
// the body of the open step, and Back, Skip for now and Continue setup. Progress is
// read from the broker (see setup-api.ts) and marked there; this page only shows it.
// The focus moves to the step's heading whenever the step changes.
import { type ComponentType, useEffect, useRef } from "react";
import type { PendingOperation } from "./api";
import { setupHash } from "./route";
import { markSetup, type SetupStatus, stepOf } from "./setup-api";
import {
  firstOpenStep,
  progressLine,
  stateTone,
  stateWord,
  WIZARD_STEPS,
  type WizardStepId,
  wizardStep,
} from "./setup-copy";
import {
  AssistantBody,
  FirstRequestBody,
  MachineBody,
  type StepProps,
} from "./setup-steps";
import {
  DevicesBody,
  DoneBody,
  NotificationsBody,
  PermissionsBody,
  VaultBody,
  WelcomeBody,
} from "./setup-steps-more";
import { Badge, Notice } from "./ui";

const BODIES: Record<WizardStepId, ComponentType<StepProps>> = {
  welcome: WelcomeBody,
  vault: VaultBody,
  machine: MachineBody,
  assistant: AssistantBody,
  "first-request": FirstRequestBody,
  permissions: PermissionsBody,
  devices: DevicesBody,
  notifications: NotificationsBody,
  done: DoneBody,
};

export function SetupScreen({
  step,
  status,
  operations,
  onGo,
  onChanged,
  onError,
}: {
  // The step named in the hash ("" when none).
  step: string;
  status: SetupStatus | undefined;
  operations: PendingOperation[];
  onGo: (hash: string) => void;
  onChanged: (next: SetupStatus) => void;
  onError: (error: unknown) => unknown;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const current = status
    ? (wizardStep(step)?.id ?? firstOpenStep(status))
    : undefined;

  // Focus follows the step, so keyboard and screen-reader users land on its title.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [current]);

  if (!status || current === undefined)
    return <p className="muted">Loading your setup…</p>;

  const index = WIZARD_STEPS.findIndex((entry) => entry.id === current);
  const meta = WIZARD_STEPS[index];
  if (!meta) return null;
  const prev = WIZARD_STEPS[index - 1];
  const next = WIZARD_STEPS[index + 1];
  const Body = BODIES[current];
  const required = status.counts.required;
  // Only the counted steps have a state to change; welcome and done do not.
  const stepId =
    current === "welcome" || current === "done" ? undefined : current;
  const isStep = stepId !== undefined;
  const state = stepId ? stepOf(status, stepId).state : undefined;

  // Changes made from the page never leave a stale view behind.
  const change = (next: SetupStatus) => onChanged(next);
  const run = async (work: () => Promise<SetupStatus>, then?: string) => {
    try {
      const updated = await work();
      change(updated);
      if (then) onGo(then);
    } catch (failure) {
      onError(failure);
    }
  };

  const bodyProps: StepProps = {
    status,
    onChanged: change,
    onError,
    onGo,
    operations,
  };

  return (
    <>
      <div className="page-head">
        <h2>Set up homectl</h2>
        <p>
          Finish the steps that need you. Each one shows what to do, and the
          checklist keeps your place.
        </p>
      </div>
      <div className="setup-summary">
        <progress
          className="setup-progress"
          value={status.counts.requiredDone}
          max={required}
          aria-label="Required steps done"
        />
        <span className="small">{progressLine(status)}</span>
      </div>
      <div className="setup-layout">
        <nav className="setup-rail" aria-label="Setup steps">
          <ol>
            {WIZARD_STEPS.map((entry, position) => {
              const entryState =
                entry.id === "welcome" || entry.id === "done"
                  ? undefined
                  : stepOf(status, entry.id);
              return (
                <li key={entry.id}>
                  <a
                    href={setupHash(entry.id)}
                    className={`setup-rail-item${entry.id === current ? " is-current" : ""}`}
                    aria-current={entry.id === current ? "step" : undefined}
                  >
                    <span className="setup-rail-num" aria-hidden="true">
                      {position + 1}
                    </span>
                    <span className="setup-rail-name">{entry.title}</span>
                    {entryState ? (
                      <Badge tone={stateTone(entryState.state)}>
                        {stateWord(entryState, status.next)}
                      </Badge>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
        <section className="setup-card" aria-labelledby="setup-step-title">
          <p className="small muted">
            Step {index + 1} of {WIZARD_STEPS.length}
            {meta.required ? "" : " · optional"}
          </p>
          <h2
            id="setup-step-title"
            tabIndex={-1}
            ref={heading}
            className="setup-step-title"
          >
            {meta.title}
          </h2>
          <p className="lead">{meta.line}</p>
          <Body {...bodyProps} />
        </section>
      </div>
      <footer className="setup-foot">
        {current === "welcome" ? (
          <>
            <button
              type="button"
              className="primary"
              onClick={() =>
                run(() => markSetup({ action: "welcome" }), setupHash("vault"))
              }
            >
              Start setup
            </button>
            <button
              type="button"
              onClick={() =>
                run(() => markSetup({ action: "welcome" }), setupHash())
              }
            >
              Not now
            </button>
          </>
        ) : null}
        {current !== "welcome" && prev ? (
          <a className="button" href={setupHash(prev.id)}>
            Back
          </a>
        ) : null}
        {stepId && state === "open" ? (
          <button
            type="button"
            onClick={() =>
              run(
                () => markSetup({ action: "skip", step: stepId }),
                next ? setupHash(next.id) : undefined,
              )
            }
          >
            Skip for now
          </button>
        ) : null}
        {stepId && state === "skipped" ? (
          <button
            type="button"
            onClick={() =>
              run(() => markSetup({ action: "reopen", step: stepId }))
            }
          >
            Come back to this
          </button>
        ) : null}
        {current !== "welcome" && current !== "done" && next ? (
          <a className="button primary" href={setupHash(next.id)}>
            Continue setup
          </a>
        ) : null}
        {current === "done" ? (
          <a className="button" href="#/">
            Back to Needs you
          </a>
        ) : null}
      </footer>
    </>
  );
}
