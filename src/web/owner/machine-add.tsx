// "Add a machine": a step sheet with five numbered steps and a done state. Each
// step says what it needs and what happens next. The owner types the password
// only where it is needed, and nothing secret is kept between steps. The key
// is made in the owner's private terminal (never by an assistant), and this sheet
// waits for it to appear.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { describeError } from "./api";
import { CopyButton } from "./copy";
import {
  type AccessTier,
  type EnrollInput,
  type KeyStatus,
  keyStatus,
} from "./machine-api";
import { AccessPicker, CommandsField } from "./machine-access";
import { InstallSteps, PublicKeyBlock } from "./machine-install";
import { EnrollStep, IdentityStep } from "./machine-identity";
import {
  accessLabel,
  addressProblem,
  commandProblem,
  isRootLogin,
  loginProblem,
  nameProblem,
  parseCommandLines,
  ROOT_WARNING,
} from "./machine-words";
import { Dialog, Field, Notice } from "./ui";

type StepId = "form" | "key" | "install" | "identity" | "enroll" | "done";
const NUMBERED: StepId[] = ["form", "key", "install", "identity", "enroll"];
const TITLES: Record<StepId, string> = {
  form: "Name the machine and choose its access",
  key: "Make the key",
  install: "Install the key on the machine",
  identity: "Check the machine's identity",
  enroll: "Add the machine",
  done: "The machine is added",
};

interface Draft {
  name: string;
  address: string;
  port: string;
  login: string;
  access: AccessTier;
  commands: string;
}

const EMPTY: Draft = {
  name: "",
  address: "",
  port: "22",
  login: "",
  access: "observe",
  commands: "",
};

export function AddMachineSheet({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (result: { name: string; os: string }) => void;
}) {
  const [step, setStep] = useState<StepId>("form");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tried, setTried] = useState(false);
  const [publicKey, setPublicKey] = useState<string | undefined>();
  const [fingerprint, setFingerprint] = useState<string | undefined>();
  const [added, setAdded] = useState<
    { name: string; os: string } | undefined
  >();
  const heading = useRef<HTMLHeadingElement>(null);

  // Each step starts at its heading, so the keyboard lands where the step begins.
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const root = isRootLogin(draft.login);
  // A root login is always Full admin; the picker shows that and locks the rest.
  const access: AccessTier = root ? "full" : draft.access;
  const port = Number(draft.port);
  const portProblem =
    Number.isInteger(port) && port >= 1 && port <= 65535
      ? undefined
      : "The SSH port must be a number from 1 to 65535.";
  const commands = parseCommandLines(draft.commands);
  const problems = [
    nameProblem(draft.name),
    addressProblem(draft.address),
    portProblem,
    loginProblem(draft.login),
    access === "sudo-approved" ? commandProblem(commands) : undefined,
  ].filter((text): text is string => text !== undefined);
  const enrollInput: Omit<EnrollInput, "password"> = {
    name: draft.name,
    address: draft.address.trim(),
    port,
    user: draft.login.trim(),
    access,
    fingerprint: fingerprint ?? "",
    ...(access === "sudo-approved" ? { sudo_allow: commands } : {}),
  };
  const numbered = NUMBERED.indexOf(step) + 1;

  return (
    <Dialog title="Add a machine" onClose={onClose} className="machine-sheet">
      {step !== "done" ? (
        <div
          className="step-bar"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={NUMBERED.length}
          aria-valuenow={numbered}
          aria-valuetext={`Step ${numbered} of ${NUMBERED.length}`}
        >
          <span data-step={numbered} />
        </div>
      ) : null}
      <p className="wizard-step">
        {step === "done" ? "Done" : `Step ${numbered} of ${NUMBERED.length}`}
      </p>
      <h3 ref={heading} tabIndex={-1} className="wizard-title">
        {TITLES[step]}
      </h3>

      {step === "form" ? (
        <form
          className="stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setTried(true);
            if (problems.length === 0) setStep("key");
          }}
        >
          <Field
            id="machine-name"
            label="Name"
            hint="for example nas or printer"
          >
            <input
              id="machine-name"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </Field>
          <Field
            id="machine-address"
            label="Address"
            hint="IP address or host name"
          >
            <input
              id="machine-address"
              className="mono"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={draft.address}
              onChange={(event) =>
                setDraft({ ...draft, address: event.target.value })
              }
            />
          </Field>
          <Field
            id="machine-port"
            label="SSH port"
            hint="22 unless your machine uses another"
          >
            <input
              id="machine-port"
              inputMode="numeric"
              value={draft.port}
              onChange={(event) =>
                setDraft({ ...draft, port: event.target.value })
              }
            />
          </Field>
          <Field
            id="machine-login"
            label="Login name"
            hint="the account homectl signs in as"
          >
            <input
              id="machine-login"
              className="mono"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={draft.login}
              onChange={(event) =>
                setDraft({ ...draft, login: event.target.value })
              }
            />
          </Field>
          <AccessPicker
            value={access}
            lockedToFull={root}
            onChange={(next) => setDraft({ ...draft, access: next })}
          />
          {root ? <Notice tone="warn">{ROOT_WARNING}</Notice> : null}
          {access === "sudo-approved" ? (
            <CommandsField
              value={draft.commands}
              onChange={(value) => setDraft({ ...draft, commands: value })}
              problem={tried ? commandProblem(commands) : undefined}
            />
          ) : null}
          {tried && problems.length > 0 ? (
            <Notice tone="bad">
              <p>Before you go on:</p>
              <ul className="plain-list-bare">
                {problems.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <div className="row">
            <button type="submit" className="primary">
              Next: make the key
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {step === "key" ? (
        <KeyStep
          name={draft.name}
          onBack={() => setStep("form")}
          onNext={(key) => {
            setPublicKey(key);
            setStep("install");
          }}
        />
      ) : null}

      {step === "install" && publicKey ? (
        <>
          <PublicKeyBlock publicKey={publicKey} />
          <InstallSteps
            name={draft.name}
            user={draft.login.trim()}
            publicKey={publicKey}
          />
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => setStep("identity")}
            >
              Next: check the machine's identity
            </button>
            <button type="button" onClick={() => setStep("key")}>
              Back
            </button>
          </div>
        </>
      ) : null}

      {step === "identity" ? (
        <>
          <IdentityStep
            address={draft.address.trim()}
            port={port}
            onConfirmed={(value) => {
              setFingerprint(value);
              setStep("enroll");
            }}
          />
          <div className="row">
            <button type="button" onClick={() => setStep("install")}>
              Back
            </button>
          </div>
        </>
      ) : null}

      {step === "enroll" && fingerprint ? (
        <EnrollStep
          input={{ ...enrollInput, fingerprint }}
          summary={`${draft.name} at ${draft.address.trim()}, as ${draft.login.trim()}, ${accessLabel(access)}.`}
          onBack={() => setStep("identity")}
          onAdded={(result) => {
            setAdded(result);
            setStep("done");
            onAdded(result);
          }}
        />
      ) : null}

      {step === "done" && added ? (
        <div aria-live="polite">
          <Notice tone="good">
            {added.name} is on your list. It runs {added.os}. Its identity is
            checked, and you can check it again any time.
          </Notice>
          <p>
            Next, decide what an assistant may do there. An assistant can reach
            only the machines you give it.
          </p>
          <div className="row">
            <a className="button primary" href="#/agents" onClick={onClose}>
              Let an assistant use it
            </a>
            <button type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

// Step 2: the key is made in the owner's private terminal. This step waits for it.
function KeyStep({
  name,
  onBack,
  onNext,
}: {
  name: string;
  onBack: () => void;
  onNext: (publicKey: string) => void;
}) {
  const [status, setStatus] = useState<KeyStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const command = `home-ctl key create ${name}`;

  useEffect(() => {
    let live = true;
    const look = () =>
      keyStatus(name)
        .then((next) => {
          if (live) {
            setStatus(next);
            setError(undefined);
          }
        })
        .catch((failure: unknown) => {
          if (live) setError(describeError(failure));
        });
    void look();
    const timer = setInterval(() => void look(), 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [name]);

  const publicKey = status?.present ? status.publicKey : undefined;
  if (publicKey)
    return (
      <>
        <Notice tone="good">The key for {name} is ready.</Notice>
        <PublicKeyBlock publicKey={publicKey} />
        {status?.fingerprint ? (
          <p className="small">
            Fingerprint of the key:{" "}
            <span className="mono">{status.fingerprint}</span>
          </p>
        ) : null}
        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => onNext(publicKey)}
          >
            Next: install the key
          </button>
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </>
    );

  return (
    <>
      <p>
        In your private terminal, run this command. Do not run it in an
        assistant's chat: the private key is made on your computer and kept in
        your vault.
      </p>
      <div className="command-block">
        <pre className="key-block" tabIndex={0} aria-label="Key command">
          {command}
        </pre>
        <CopyButton label="command" text={command} primary />
      </div>
      <p className="small muted">
        The private key is never shown here. This page checks for the key every
        few seconds, and carries on by itself once it appears.
      </p>
      {status?.reason ? <Notice tone="warn">{status.reason}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <p role="status" className="small">
        Waiting for the key…
      </p>
      <div className="row">
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}
