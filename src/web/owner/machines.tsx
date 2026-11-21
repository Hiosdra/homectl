// Machines: the computers and NAS homectl can reach. Each card says what the
// machine is, how far homectl trusts it, when it last answered, and which
// assistants can reach it. Details shows the tier id, the login, the pinned
// fingerprint and the inventory fields. Adding a machine opens the step sheet.
import { useEffect, useId, useState } from "react";
import { describeError } from "./api";
import { AddMachineSheet } from "./machine-add";
import {
  type ActionResult,
  AccessDialog,
  CheckDialog,
  RemoveDialog,
} from "./machine-actions";
import { type MachineRow, listMachines } from "./machine-api";
import { SetupLink } from "./setup-checklist";
import {
  accessLabel,
  accessSentence,
  addressLine,
  assistantLine,
  factsFor,
  identityWords,
  probeLine,
} from "./machine-words";
import { Icon } from "./icons";
import { Badge, Notice } from "./ui";
import type { Tone } from "./ui";

type Action = "check" | "access" | "remove";

export function MachinesScreen({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [machines, setMachines] = useState<MachineRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<ActionResult | undefined>();
  const [acting, setActing] = useState<
    { action: Action; name: string } | undefined
  >();

  const load = async () => {
    try {
      const data = await listMachines();
      setMachines(data.machines);
      setError(undefined);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const current = acting
    ? machines?.find((machine) => machine.name === acting.name)
    : undefined;
  const done = (next: ActionResult) => {
    setResult(next);
    void load();
  };

  return (
    <>
      <div className="page-head">
        <h2>Machines</h2>
        <p>
          A machine is a computer or NAS that homectl can run commands on,
          through a key that stays in your vault. Each one has an access level.
          Nothing is trusted until you have checked its identity.
        </p>
      </div>
      <div className="row between machines-bar">
        <p className="small muted">
          {machines === undefined
            ? "Loading your machines…"
            : `${machines.length} ${machines.length === 1 ? "machine" : "machines"}`}
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" />
          Add a machine
        </button>
      </div>
      {result ? (
        <Notice tone={result.tone === "good" ? "good" : "bad"}>
          {result.text}
        </Notice>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}

      {machines?.length === 0 ? (
        <section className="empty-machines">
          <p>
            No machines yet.{" "}
            <button
              type="button"
              className="quiet"
              onClick={() => setAdding(true)}
            >
              Add your first machine →
            </button>
          </p>
          <p className="small muted">
            New to this?{" "}
            <SetupLink step="machine">Follow the guided setup →</SetupLink>
          </p>
        </section>
      ) : null}

      <div className="request-list">
        {machines?.map((machine) => (
          <MachineCard
            key={machine.name}
            machine={machine}
            onAction={(action) => setActing({ action, name: machine.name })}
          />
        ))}
      </div>

      {adding ? (
        <AddMachineSheet
          onClose={() => setAdding(false)}
          onAdded={({ name, os }) => {
            setResult({
              tone: "good",
              text: `${name} is on your list. It runs ${os}.`,
            });
            void load();
          }}
        />
      ) : null}
      {current && acting?.action === "check" ? (
        <CheckDialog
          machine={current}
          onClose={() => setActing(undefined)}
          onDone={done}
        />
      ) : null}
      {current && acting?.action === "access" ? (
        <AccessDialog
          machine={current}
          onClose={() => setActing(undefined)}
          onDone={done}
        />
      ) : null}
      {current && acting?.action === "remove" ? (
        <RemoveDialog
          machine={current}
          onClose={() => setActing(undefined)}
          onDone={done}
        />
      ) : null}
    </>
  );
}

function accessTone(access: MachineRow["access"]): Tone {
  if (access === "full") return "warn";
  if (access === "sudo-approved") return "info";
  return "neutral";
}

function MachineCard({
  machine,
  onAction,
}: {
  machine: MachineRow;
  onAction: (action: Action) => void;
}) {
  const [details, setDetails] = useState(false);
  const id = useId();
  const identity = identityWords(machine.pinned);
  return (
    <section
      className="item request-card machine-card"
      aria-labelledby={`${id}-name`}
    >
      <div className="request-head">
        <h3 id={`${id}-name`} className="machine-name">
          {machine.name}
        </h3>
        <div className="machine-badges">
          <Badge tone={accessTone(machine.access)}>
            {accessLabel(machine.access)}
          </Badge>
          <Badge
            tone={identity.tone === "good" ? "good" : "neutral"}
            icon={identity.tone === "good" ? "check" : "clock"}
          >
            {identity.label}
          </Badge>
        </div>
      </div>
      <p className="mono small machine-address">
        {addressLine(machine)}
        {machine.user ? ` · login ${machine.user}` : ""}
      </p>
      <p className="small">{accessSentence(machine.access)}</p>
      <p className="small">{probeLine(machine.probe)}</p>
      <p className="small">
        {assistantLine(machine.assistants)}{" "}
        {machine.assistants.length === 0 ? (
          <a href="#/agents">Let an assistant use it</a>
        ) : null}
      </p>
      <div className="request-actions">
        <button type="button" onClick={() => onAction("check")}>
          Check again
        </button>
        <button type="button" onClick={() => onAction("access")}>
          Change access level…
        </button>
        <button
          type="button"
          aria-expanded={details}
          onClick={() => setDetails((open) => !open)}
        >
          {details ? "Hide details" : "Details"}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => onAction("remove")}
        >
          Remove machine…
        </button>
      </div>
      {details ? (
        <dl className="machine-facts">
          {factsFor(machine).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd
                className={label === "Pinned fingerprint" ? "mono" : undefined}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
