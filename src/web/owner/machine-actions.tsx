// The owner's three changes to a machine, each a dialog that says what it does
// and asks for the owner password in the same request: check again, change the
// access level, and remove the machine. Nothing here is saved between opens.
import { type FormEvent, useState } from "react";
import { describeError } from "./api";
import {
  type AccessTier,
  type MachineRow,
  changeAccess,
  checkMachine,
  removeMachine,
} from "./machine-api";
import { AccessPicker, CommandsField } from "./machine-access";
import {
  ACCESS_TIERS,
  accessLabel,
  commandProblem,
  parseCommandLines,
  removalNote,
  ROOT_WARNING,
} from "./machine-words";
import { Dialog, Notice, PasswordStep } from "./ui";

// The result of an action, shown on the screen after the dialog closes.
export type ActionResult = { tone: "good" | "bad"; text: string };

export function CheckDialog({
  machine,
  onClose,
  onDone,
}: {
  machine: MachineRow;
  onClose: () => void;
  onDone: (result: ActionResult) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || password === "") return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      const result = await checkMachine(machine.name, secret);
      if (result.ok)
        onDone({
          tone: "good",
          text: `${machine.name} answered. It runs ${result.os ?? "a system homectl can read"}.`,
        });
      else
        onDone({
          tone: "bad",
          text: `${machine.name} did not answer the check: ${result.reason ?? "unknown reason"}`,
        });
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
      return;
    }
    setBusy(false);
    onClose();
  };
  return (
    <Dialog title={`Check ${machine.name}`} onClose={onClose}>
      <p>
        homectl connects with the key and runs one read-only command to see what
        the machine runs. It changes nothing on the machine.
      </p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <PasswordStep
          value={password}
          onChange={setPassword}
          hint="required for every check"
        />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="row">
          <button
            type="submit"
            className="primary"
            disabled={busy || password === ""}
          >
            {busy ? "Checking…" : "Check again"}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function AccessDialog({
  machine,
  onClose,
  onDone,
}: {
  machine: MachineRow;
  onClose: () => void;
  onDone: (result: ActionResult) => void;
}) {
  const root = machine.user === "root";
  const [access, setAccess] = useState<AccessTier>(
    root ? "full" : machine.access,
  );
  const [commands, setCommands] = useState(machine.sudoAllow.join("\n"));
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const parsed = parseCommandLines(commands);
  const problem =
    access === "sudo-approved" ? commandProblem(parsed) : undefined;
  const rank = ACCESS_TIERS.findIndex((tier) => tier.id === access);
  const before = ACCESS_TIERS.findIndex((tier) => tier.id === machine.access);
  const raising = rank > before;
  const changed =
    access !== machine.access || commands !== machine.sudoAllow.join("\n");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || password === "" || problem || !changed) return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      await changeAccess(
        machine.name,
        access,
        secret,
        access === "sudo-approved" ? parsed : undefined,
      );
      onDone({
        tone: "good",
        text: `${machine.name} is now ${accessLabel(access)}.`,
      });
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Change access for ${machine.name}`} onClose={onClose}>
      <p>
        This changes what homectl allows on {machine.name}. It does not change
        the machine's own accounts or sudo rules. Anything you installed on the
        machine stays until you remove it there.
      </p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <AccessPicker
          value={access}
          lockedToFull={root}
          disabled={busy}
          onChange={setAccess}
        />
        {access === "sudo-approved" ? (
          <CommandsField
            value={commands}
            onChange={setCommands}
            problem={problem}
          />
        ) : null}
        {raising ? (
          <Notice tone="warn">
            This gives assistants more power on {machine.name}. Changes still
            wait for your approval by default.
          </Notice>
        ) : null}
        {root ? <Notice tone="warn">{ROOT_WARNING}</Notice> : null}
        <PasswordStep
          value={password}
          onChange={setPassword}
          hint="required for every access change"
        />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="row">
          <button
            type="submit"
            className="primary"
            disabled={
              busy || password === "" || problem !== undefined || !changed
            }
          >
            {busy ? "Saving…" : "Change access level"}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RemoveDialog({
  machine,
  onClose,
  onDone,
}: {
  machine: MachineRow;
  onClose: () => void;
  onDone: (result: ActionResult) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || password === "") return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      const result = await removeMachine(machine.name, secret);
      onDone({
        tone: "good",
        text: `${machine.name} is removed from homectl. ${removalNote(result.assistantsUpdated)}`,
      });
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Remove ${machine.name}?`} onClose={onClose}>
      <p>homectl will stop connecting to {machine.name}.</p>
      <p>
        <strong>What this removes:</strong> the machine from your list, its
        pinned identity, and its access for every assistant.
      </p>
      <p>
        <strong>What it does not delete:</strong> the key in your vault, the
        public key on the machine, or any file on the machine. To remove those,
        do it in your vault and on the machine.
      </p>
      {machine.assistants.length > 0 ? (
        <Notice tone="warn">
          {machine.assistants.map((item) => item.name).join(", ")} will lose
          access to it.
        </Notice>
      ) : null}
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <PasswordStep
          value={password}
          onChange={setPassword}
          hint="required to remove"
        />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <div className="row">
          <button
            type="submit"
            className="danger"
            disabled={busy || password === ""}
          >
            {busy ? "Removing…" : "Remove machine"}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
