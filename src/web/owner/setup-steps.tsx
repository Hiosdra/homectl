// Step bodies of the guided setup, part one: the machine, the assistant and the first
// safe request. The machine and the assistant reuse the existing sheet and form (part
// 2 and the Assistants add form), so nothing is rebuilt here. Every terminal step shows
// a copyable command and detects its own result through the status the screen polls.
import { useEffect, useState } from "react";
import { type ClientView, ownerCall, type PendingOperation } from "./api";
import {
  AddAssistant,
  connectCommand,
  type Issued,
  NewKey,
} from "./agent-form";
import { CopyButton } from "./copy";
import { Icon } from "./icons";
import { listMachines } from "./machine-api";
import { AddMachineSheet } from "./machine-add";
import { type SetupStatus, readSetup, stepOf } from "./setup-api";
import { SetupLink, TerminalHint } from "./setup-checklist";
import { Argv, Badge, fmtTime, Notice } from "./ui";

export interface StepProps {
  status: SetupStatus;
  // Hands a fresh status back to the screen.
  onChanged: (next: SetupStatus) => void;
  onError: (error: unknown) => unknown;
  onGo: (hash: string) => void;
  // Approvals waiting for the owner now (the same list Needs you shows).
  operations: PendingOperation[];
}

// Re-reads the status after an action the server did not answer with one.
export async function refreshInto(onChanged: (next: SetupStatus) => void) {
  onChanged(await readSetup());
}

// A small "Done" line for a step the broker has detected.
export function DoneLine({ children }: { children: string }) {
  return (
    <Notice tone="good">
      <Icon name="check" /> {children}
    </Notice>
  );
}

export function MachineBody({ status, onChanged, onError }: StepProps) {
  const [adding, setAdding] = useState(false);
  const step = stepOf(status, "machine");
  const done = step.state === "done";
  return (
    <>
      {done ? (
        <DoneLine>
          {status.facts.readyMachines === 1
            ? "One machine is checked and ready."
            : `${status.facts.readyMachines} machines are checked and ready.`}
        </DoneLine>
      ) : null}
      <p>
        A machine is a computer or NAS that homectl can run commands on. Its key
        stays in your vault. Give the machine a short name, such as{" "}
        <code>nas</code>.
      </p>
      <h4>1. Make its key in your private terminal</h4>
      <TerminalHint
        label="key command"
        command="home-ctl key create <name>"
        note="Enter your vault password when asked. Only the public part is shown here."
      />
      <h4>2. Add the machine</h4>
      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={() => setAdding(true)}
        >
          <Icon name="server" /> Add a machine
        </button>
      </div>
      <details className="setup-details">
        <summary>Details: what each access level allows</summary>
        <ul className="plain-steps">
          <li>
            <strong>Look only</strong> (the default): read-only checks, no
            changes.
          </li>
          <li>
            <strong>Everyday account</strong>: ordinary commands; each change
            asks you.
          </li>
          <li>
            <strong>Admin with your approval</strong>: only the admin commands
            you list.
          </li>
          <li>
            <strong>Full admin</strong>: the account's full power, still
            reviewed. Root is always this level, with a warning.
          </li>
        </ul>
        <p className="small muted">
          Nothing is trusted until you have checked the machine's fingerprint on
          its own console. The sheet walks you through it.
        </p>
      </details>
      {adding ? (
        <AddMachineSheet
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            refreshInto(onChanged).catch(onError);
          }}
        />
      ) : null}
    </>
  );
}

export function AssistantBody({ status, onChanged, onError }: StepProps) {
  const [clients, setClients] = useState<ClientView[] | undefined>();
  const [machines, setMachines] = useState<string[] | undefined>();
  const [issued, setIssued] = useState<Issued | undefined>();
  const step = stepOf(status, "assistant");
  const done = step.state === "done";
  const hasMachines =
    status.facts.readyMachines > 0 || status.facts.machines > 0;

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

  const waiting =
    !done && (issued !== undefined || status.facts.assistants > 0);
  const active = (clients ?? []).filter((client) => !client.revoked);

  return (
    <>
      {done ? (
        <DoneLine>An assistant has connected to homectl.</DoneLine>
      ) : null}
      {!hasMachines ? (
        <Notice>
          An assistant needs at least one machine to work on.{" "}
          <SetupLink step="machine">Add a machine first →</SetupLink>
        </Notice>
      ) : issued ? (
        <NewKey issued={issued} onDismiss={() => setIssued(undefined)} />
      ) : (
        <AddAssistant
          clients={clients ?? []}
          machines={machines ?? []}
          onCreated={(result) => {
            setIssued(result);
            refreshInto(onChanged).catch(onError);
          }}
          onError={onError}
        />
      )}
      {waiting && !done ? (
        <p className="setup-waiting" role="status" aria-live="polite">
          <Badge tone="neutral">Waiting</Badge> The assistant has not connected
          yet. Run its command on that computer. This page updates by itself.
        </p>
      ) : null}
      {!done && !issued && active.length > 0 && hasMachines ? (
        <details className="setup-details">
          <summary>Show the command for an assistant you already added</summary>
          <ul className="plain-steps">
            {active.map((client) => (
              <li key={client.id}>
                <strong>{client.name || client.id}</strong>
                <TerminalHint
                  label="connect command"
                  command={connectCommand(client.id, client.hosts)}
                  note="This makes a new key and replaces the old one. Use it only if the assistant lost its key."
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

// The example prompts the owner pastes into Claude or Codex. The first is read-only;
// the second makes a tiny change that the owner has to approve.
export function promptsFor(machine: string): {
  readOnly: string;
  change: string;
} {
  const host = machine || "<your machine>";
  return {
    readOnly: `Using homectl, check how long ${host} has been running and how much free disk space it has. Use read-only commands only.`,
    change: `Using homectl, create an empty file named homectl-test.txt in the home folder on ${host}. Ask me to approve it first.`,
  };
}

export function FirstRequestBody({ status, operations, onError }: StepProps) {
  const [machine, setMachine] = useState("");
  useEffect(() => {
    let current = true;
    listMachines()
      .then((inventory) => {
        if (current && inventory.machines[0])
          setMachine(inventory.machines[0].name);
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [onError]);
  const step = stepOf(status, "first-request");
  const done = step.state === "done";
  const prompts = promptsFor(machine);
  const arrived = status.facts.requests > 0;
  const waiting = operations[0];
  return (
    <>
      {done ? (
        <DoneLine>
          Your first request was answered. You made the decision.
        </DoneLine>
      ) : null}
      <p>
        Paste the first prompt into Claude or Codex. It only reads something, so
        nothing changes. Then paste the second. It makes a tiny change, and
        homectl asks you to approve it before it runs.
      </p>
      <h4>1. Read-only check</h4>
      <div className="setup-prompt">
        <p>{prompts.readOnly}</p>
        <CopyButton label="first prompt" text={prompts.readOnly} />
      </div>
      <h4>2. A small change you approve</h4>
      <div className="setup-prompt">
        <p>{prompts.change}</p>
        <CopyButton label="second prompt" text={prompts.change} />
      </div>
      {waiting ? (
        <Notice tone="warn">
          <strong>A request is waiting for you.</strong> It asks to run{" "}
          <Argv argv={waiting.argv} /> on {waiting.host}.{" "}
          <a href={`#/approvals/${waiting.id}`}>Review it →</a>
        </Notice>
      ) : arrived && !done ? (
        <p className="small muted">
          A request arrived
          {status.facts.firstRequestAt
            ? ` at ${fmtTime(status.facts.firstRequestAt)}`
            : ""}
          . Approve or deny it to finish this step.
        </p>
      ) : (
        <p className="small muted">
          Nothing has arrived yet. When your assistant asks, its request appears
          here and under Needs you. Nothing runs until you approve it.
        </p>
      )}
      <details className="setup-details">
        <summary>Details</summary>
        <p className="small muted">
          The assistant can only ask. Each request is checked against your
          permissions. Approving allows that exact command once. It creates no
          rule unless you choose to remember it.
        </p>
      </details>
    </>
  );
}
