// Setup requests from an assistant, in Needs you (0.3 acceptance). The title says
// what will change in plain words ("Add nas to homectl?"). The fields and the
// machine's presented key sit under Details. Adding a machine asks the owner to
// compare the presented fingerprint with a trusted source and type it; the approve
// button stays off until the typed value matches. Nothing here is inline-styled:
// the panel's CSP forbids inline styles.
import { useId } from "react";
import type { PendingOperation } from "./api";
import { Field } from "./ui";

export const SETUP_KIND_LABEL: Record<string, string> = {
  scan: "Look for a machine's SSH key",
  probe: "Check that a machine answers",
  enroll: "Add a machine to homectl",
  access: "Change a machine's access level",
  preset: "Change the AI permission setting",
  remove: "Remove a machine from homectl",
};

const PRESET_LABEL: Record<string, string> = {
  conservative: "Ask me first",
  routine: "AI helps with small fixes",
  delegated: "AI decides more",
};

const ACCESS_LABEL: Record<string, string> = {
  observe: "look only",
  user: "everyday account",
  "sudo-approved": "admin with your approval",
  full: "full admin",
};

export function isSetupOperation(operation: PendingOperation): boolean {
  return operation.setup !== undefined;
}

// The question the owner reads, in plain words. The broker never sends a title.
export function setupTitle(operation: PendingOperation): string {
  const setup = operation.setup;
  if (!setup) return "";
  const input = setup.input;
  switch (setup.kind) {
    case "scan":
      return `Look for the SSH key at ${input.address ?? "that address"}?`;
    case "probe":
      return `Check that ${input.name} answers?`;
    case "enroll":
      return `Add ${input.name} to homectl?`;
    case "access":
      return `Give ${input.name} ${ACCESS_LABEL[input.access ?? ""] ?? input.access}?`;
    case "preset":
      return `Change the AI permission setting to ${PRESET_LABEL[input.preset ?? ""] ?? input.preset}?`;
    case "remove":
      return `Remove ${input.name} from homectl?`;
    default:
      return "Make a setup change?";
  }
}

// What the change does, one sentence under the title.
export function setupBodyText(operation: PendingOperation): string {
  const setup = operation.setup;
  if (!setup) return "";
  switch (setup.kind) {
    case "scan":
      return "It only looks. The key the address shows is listed for you to compare. Nothing is trusted or added.";
    case "probe":
      return "It runs one read-only check on the machine. Nothing changes.";
    case "enroll":
      return "It trusts the key that the scan you approved recorded for this address, adds the machine to your list and runs a check. Compare the key with a trusted source before you approve.";
    case "access":
      return "It changes what the assistant may ask this machine to do. Your machine is not changed.";
    case "preset":
      return "It changes which AI requests run without asking you. Saved rules stay.";
    case "remove":
      return "It takes the machine off your list and forgets its trusted key. The machine itself is not changed.";
    default:
      return "";
  }
}

// The presented key(s) as the broker recorded them when the request was made.
export function presentedKeys(operation: PendingOperation) {
  return operation.setup?.presented ?? [];
}

// True when the typed value is one of the keys the machine presented.
export function fingerprintConfirmed(
  operation: PendingOperation,
  typed: string,
): boolean {
  const value = typed.trim();
  return (
    value !== "" &&
    presentedKeys(operation).some((key) => key.fingerprint === value)
  );
}

// Rows for Details. They sit inside the approval's <dl>.
export function SetupDetailRows({
  operation,
}: {
  operation: PendingOperation;
}) {
  const setup = operation.setup;
  if (!setup) return null;
  const input = setup.input;
  const keys = presentedKeys(operation);
  return (
    <>
      <dt>Area</dt>
      <dd>{operation.area ?? "Machines"}</dd>
      <dt>Request</dt>
      <dd>
        <span className="mono">{setup.kind}</span>
      </dd>
      {input.name ? (
        <>
          <dt>Name</dt>
          <dd>
            <span className="mono">{input.name}</span>
          </dd>
        </>
      ) : null}
      {input.address ? (
        <>
          <dt>Address</dt>
          <dd>
            <span className="mono">
              {input.address}
              {input.port ? `:${input.port}` : ""}
            </span>
          </dd>
        </>
      ) : null}
      {input.user ? (
        <>
          <dt>Login</dt>
          <dd>
            <span className="mono">{input.user}</span>
          </dd>
        </>
      ) : null}
      {input.access ? (
        <>
          <dt>Access level</dt>
          <dd>
            {ACCESS_LABEL[input.access] ?? input.access}{" "}
            <span className="mono">({input.access})</span>
          </dd>
        </>
      ) : null}
      {input.preset ? (
        <>
          <dt>Setting</dt>
          <dd>
            {PRESET_LABEL[input.preset] ?? input.preset}{" "}
            <span className="mono">({input.preset})</span>
          </dd>
        </>
      ) : null}
      {keys.length > 0 ? (
        <>
          <dt>Key the machine presented</dt>
          <dd>
            {keys.map((key) => (
              <span className="chip" key={key.fingerprint}>
                <span className="mono">{key.fingerprint}</span> {key.type}
              </span>
            ))}
          </dd>
        </>
      ) : null}
    </>
  );
}

// The plain request, shown where a command would be.
export function SetupRequestBody({
  operation,
}: {
  operation: PendingOperation;
}) {
  return (
    <div className="stack">
      <p className="small">{setupBodyText(operation)}</p>
      <p className="small muted">
        {SETUP_KIND_LABEL[operation.setup?.kind ?? ""] ?? "Setup change"}
      </p>
    </div>
  );
}

// Adding a machine: the presented key and the typed confirmation. The owner types
// the fingerprint from the card; the agent never supplies it.
export function FingerprintConfirm({
  operation,
  value,
  onChange,
}: {
  operation: PendingOperation;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const matches = fingerprintConfirmed(operation, value);
  const typed = value.trim() !== "";
  return (
    <div className="stack" role="group" aria-label="Confirm the machine's key">
      <p className="small">
        The machine presented this key. Compare it with a trusted source before
        you type it: the machine's own console, or your records. This screen
        alone does not prove it.
      </p>
      <ul className="plain-list">
        {presentedKeys(operation).map((key) => (
          <li key={key.fingerprint}>
            <span className="mono">{key.fingerprint}</span>{" "}
            <span className="small muted">{key.type}</span>
          </li>
        ))}
      </ul>
      <Field
        id={id}
        label="Type the fingerprint to confirm"
        hint="copy it exactly, starting with SHA256:"
      >
        <input
          id={id}
          className="mono"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      {typed && !matches ? (
        <p className="small" role="alert">
          That is not the fingerprint the machine presented.
        </p>
      ) : null}
    </div>
  );
}
