// The "Let your AI agent set it up" page (0.3 acceptance). Four stages: pick the
// assistant and run its one-time command in the owner's own terminal; paste the setup
// prompt into the assistant; follow the same checklist the wizard uses while the
// assistant works, with a link to Needs you whenever something waits for the owner;
// and a done state. Copy lives in setup-agent-copy.ts; the owner's password is never
// shown, typed or sent from this page.
import { useEffect, useState } from "react";
import { type ClientView, type PendingOperation, ownerCall } from "./api";
import { CopyButton } from "./copy";
import { listMachines } from "./machine-api";
import {
  AGENT_KINDS,
  AGENT_PROMPT,
  type AgentKind,
  agentProgressLine,
  connectCommandFor,
  requestsWaitingLine,
} from "./setup-agent-copy";
import { SetupChecklist, SetupLink, TerminalHint } from "./setup-checklist";
import { progressLine } from "./setup-copy";
import type { SetupStatus } from "./setup-api";
import { PathSwitch } from "./setup-path";
import { Notice } from "./ui";

export function AgentSetupPage({
  status,
  operations,
  onChanged,
  onGo,
  onError,
}: {
  status: SetupStatus;
  operations: PendingOperation[];
  onChanged: (next: SetupStatus) => void;
  onGo: (hash: string) => void;
  onError: (error: unknown) => unknown;
}) {
  const [kind, setKind] = useState<AgentKind>("claude");
  const [clients, setClients] = useState<ClientView[] | undefined>();
  const [machines, setMachines] = useState<string[] | undefined>();

  // The command needs the assistants and machines the owner already has. Read once
  // when the page opens; the progress below keeps itself up to date.
  useEffect(() => {
    let current = true;
    Promise.all([
      ownerCall<ClientView[]>("/v1/owner/clients/list"),
      listMachines(),
    ])
      .then(([list, inventory]) => {
        if (!current) return;
        setClients(list);
        setMachines(inventory.machines.map((machine) => machine.name));
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [onError]);

  const choice = AGENT_KINDS.find((entry) => entry.kind === kind);
  const command = connectCommandFor(kind, clients ?? [], machines ?? []);
  const waiting = operations.length;
  const done = status.completed;

  return (
    <>
      <div className="page-head">
        <h2>Let your AI agent set it up</h2>
        <p>
          Your assistant does the setup work through homectl. It asks before
          each change, and you approve it in Needs you. The steps that need you
          stay with you, and this page shows them.
        </p>
      </div>
      <div className="setup-summary">
        <progress
          className="setup-progress"
          value={status.counts.requiredDone}
          max={status.counts.required}
          aria-label="Required steps done"
        />
        <span className="small">{progressLine(status)}</span>
      </div>

      {waiting > 0 ? (
        <Notice tone="warn">
          <strong>{requestsWaitingLine(waiting)}</strong>{" "}
          <a className="button primary" href="#/">
            Open Needs you
          </a>
        </Notice>
      ) : null}

      <section className="setup-card agent-stage" aria-labelledby="stage-1">
        <h3 id="stage-1">1. Connect your assistant</h3>
        <p className="small muted">
          Pick the assistant you use. Then run its command in a private terminal
          on this computer.
        </p>
        <div
          className="path-cards"
          role="group"
          aria-label="Which assistant you use"
        >
          {AGENT_KINDS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className={`path-card${kind === entry.kind ? " is-chosen" : ""}`}
              aria-pressed={kind === entry.kind}
              onClick={() => setKind(entry.kind)}
            >
              <span className="path-card-title">{entry.label}</span>
              <span className="small muted">{entry.line}</span>
            </button>
          ))}
        </div>
        {machines && machines.length === 0 ? (
          <Notice>
            Your assistant needs a machine to work on.{" "}
            <SetupLink step="machine">Add a machine first →</SetupLink>
          </Notice>
        ) : null}
        <TerminalHint
          label="connect command"
          command={command}
          note={`Run this in your own terminal, not in ${choice?.label ?? "the assistant"}'s chat. You type your owner password there when asked. The password is never given to your assistant.`}
        />
      </section>

      <section className="setup-card agent-stage" aria-labelledby="stage-2">
        <h3 id="stage-2">2. Give your assistant this prompt</h3>
        <p className="small muted">
          Paste it into {choice?.label ?? "your assistant"} once the command has
          finished.
        </p>
        <div className="setup-prompt">
          <p>{AGENT_PROMPT}</p>
          <CopyButton label="setup prompt" text={AGENT_PROMPT} primary />
        </div>
      </section>

      <section className="setup-card agent-stage" aria-labelledby="stage-3">
        <h3 id="stage-3">3. Follow the progress</h3>
        {done ? (
          <section className="agent-done" aria-labelledby="stage-4">
            <Notice tone="good">
              <strong id="stage-4">You're set up.</strong> Requests from your
              assistant still appear in Needs you.
            </Notice>
            <div className="row">
              <a className="button primary" href="#/">
                Open Needs you
              </a>
              <PathSwitch
                to="manual"
                status={status}
                onChanged={onChanged}
                onGo={onGo}
                onError={onError}
              />
            </div>
          </section>
        ) : (
          <>
            <p className="setup-waiting" role="status" aria-live="polite">
              {agentProgressLine(status)}
            </p>
            <SetupChecklist
              status={status}
              onOpen={onGo}
              onChanged={onChanged}
              onError={onError}
              switchTo="manual"
            />
          </>
        )}
      </section>
    </>
  );
}
