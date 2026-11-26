// Restores a linked client's backup to a fresh device, as three plain steps: choose the
// backup and give a reason; read what will happen and accept it; check the backup with
// the owner password, then confirm with the password again. Only after the restore does
// the one-time code appear. The screen owns this component, so the code survives the
// client's row leaving the list when the restore cuts it off.
import { type FormEvent, useCallback, useId, useState } from "react";
import { describeError } from "./api";
import { CopyButton } from "./copy";
import { needsOwnerPassword } from "./auto-mode-api";
import { PairCode } from "./pair-code";
import { Badge, Dialog, Field, fmtTime, Notice, PasswordStep } from "./ui";
import { toEpoch } from "./time";
import {
  formatBytes,
  parseRestoreSeq,
  previewWorkspaceRestore,
  restoreWorkspaceClient,
  type WorkspaceRestoreIssued,
  type WorkspaceRestorePreview,
} from "./workspace-restore-api";
import { FileList } from "./workspace-restore-files";
import { suggestedServerAddress } from "./workspace-api";

type Stage = "choose" | "explain" | "confirm" | "issued";
const STEP_COUNT = 3;

function StepHeading({ step, title }: { step: number; title: string }) {
  return (
    <>
      <p className="wizard-step">
        Step {step} of {STEP_COUNT}
      </p>
      <h3 className="wizard-title">{title}</h3>
    </>
  );
}

export function RestoreFlow({
  client,
  onClose,
  onRestored,
  onError,
}: {
  // The client as it was when the restore started; the list may drop it later.
  client: { id: string; name: string; retired?: boolean };
  onClose: () => void;
  // Re-reads the server: the restored client is cut off and leaves the list.
  onRestored: () => void;
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const [stage, setStage] = useState<Stage>("choose");
  const [reason, setReason] = useState("");
  // The version as typed; blank is the latest. Checked before anything is sent.
  const [seqText, setSeqText] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [sourceRetired, setSourceRetired] = useState(client.retired === true);
  const address = suggestedServerAddress();
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<WorkspaceRestorePreview | undefined>();
  const [issued, setIssued] = useState<WorkspaceRestoreIssued | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Stable, so the dialog does not move focus on every keystroke. Closing is
  // refused once a code is on screen: the code exists only here.
  const dismiss = useCallback(() => {
    if (stage !== "issued") onClose();
  }, [stage, onClose]);

  const failure = (caught: unknown, refused: string) => {
    if (needsOwnerPassword(caught)) setError(refused);
    else {
      onError(caught);
      setError(describeError(caught));
    }
  };

  const seqCheck = parseRestoreSeq(seqText);
  const reasonText = reason.trim();

  // Another version: back to the first step, where the version is typed, and the
  // owner continues from there. Each request takes the password out of the form.
  const chooseVersion = (seq: number) => {
    setSeqText(String(seq));
    setPreview(undefined);
    setError(undefined);
    setStage("choose");
  };

  const check = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !seqCheck.ok || reasonText === "") return;
    // Take the password out of the form before the request leaves.
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      setPreview(
        await previewWorkspaceRestore({
          client: client.id,
          ...(seqCheck.seq === undefined ? {} : { seq: seqCheck.seq }),
          reason: reasonText,
          password: secret,
        }),
      );
    } catch (caught) {
      failure(
        caught,
        "That owner password was not accepted. Nothing was read.",
      );
    } finally {
      setBusy(false);
    }
  };

  const restore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !preview?.verified || (!sourceRetired && !understood)) return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      setIssued(
        await restoreWorkspaceClient({
          client: client.id,
          seq: preview.seq,
          reason: reasonText,
          password: secret,
        }),
      );
      setSourceRetired(true);
      setStage("issued");
      onRestored();
    } catch (caught) {
      failure(
        caught,
        "That owner password was not accepted. Nothing was restored.",
      );
    } finally {
      setBusy(false);
    }
  };

  // The other versions the server holds, oldest first, to choose from.
  const otherVersions = preview
    ? preview.seqs
        .filter((seq) => seq !== preview.seq)
        .sort((first, second) => first - second)
    : [];

  return (
    <Dialog
      title={
        stage === "issued"
          ? "Code for the fresh device"
          : `Restore ${client.name}`
      }
      onClose={dismiss}
    >
      {stage === "choose" ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (reasonText !== "" && seqCheck.ok) setStage("explain");
          }}
        >
          <StepHeading step={1} title="Choose the backup" />
          <p>
            homectl copies a backup of {client.name} to a fresh device. Leave
            the version blank to use the latest backup.
          </p>
          <Field
            id={`${baseId}-reason`}
            label="Why are you restoring?"
            hint="required; kept in the audit history"
          >
            <input
              id={`${baseId}-reason`}
              type="text"
              maxLength={300}
              autoComplete="off"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Field
            id={`${baseId}-seq`}
            label="Backup version"
            hint="blank is the latest"
          >
            <input
              id={`${baseId}-seq`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={!seqCheck.ok}
              value={seqText}
              onChange={(event) => setSeqText(event.target.value)}
            />
          </Field>
          {seqCheck.ok ? null : <Notice tone="bad">{seqCheck.problem}</Notice>}
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={reasonText === "" || !seqCheck.ok}
            >
              Continue
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {stage === "explain" ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (sourceRetired || understood) setStage("confirm");
          }}
        >
          <StepHeading step={2} title="What will happen" />
          <ul className="plain-list">
            <li>
              The backup goes to a fresh device. That device gets its own new
              identity; it does not become {client.name}.
            </li>
            <li>
              {sourceRetired
                ? `${client.name} remains disconnected from this server.`
                : `${client.name} is cut off from this server. It can no longer sync or send requests here.`}
            </li>
            <li>
              Files are written only to a device that has none of them yet.
            </li>
            <li>
              You get a one-time code for the fresh device. It is shown once.
            </li>
            <li>Your reason is kept in the audit history.</li>
          </ul>
          <Notice tone="warn">
            Nothing changes until you confirm in the last step.
          </Notice>
          {sourceRetired ? null : (
            <label className="check-row">
              <input
                type="checkbox"
                checked={understood}
                onChange={(event) => setUnderstood(event.target.checked)}
              />
              I understand {client.name} will be cut off.
            </label>
          )}
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={!sourceRetired && !understood}
            >
              Continue
            </button>
            <button type="button" onClick={() => setStage("choose")}>
              Back
            </button>
          </div>
        </form>
      ) : null}

      {stage === "confirm" && preview === undefined ? (
        <form className="stack" onSubmit={(event) => void check(event)}>
          <StepHeading step={3} title="Check the backup" />
          <p>
            Enter your owner password to read the backup. Reading it changes
            nothing.
          </p>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to check"
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={busy || !password}
            >
              Check the backup
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                setStage("explain");
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : null}

      {stage === "confirm" && preview !== undefined ? (
        <form className="stack" onSubmit={(event) => void restore(event)}>
          <StepHeading step={3} title="Confirm the restore" />
          <dl>
            <dt>Backup</dt>
            <dd>
              Version {preview.seq}, taken {fmtTime(preview.createdAt)},{" "}
              {formatBytes(preview.bytes)}
            </dd>
            <dt>Check</dt>
            <dd>
              {preview.verified ? (
                <Badge tone="good">Verified</Badge>
              ) : (
                <Badge tone="bad">Not verified</Badge>
              )}
            </dd>
            <dt>Other backups</dt>
            <dd>
              {otherVersions.length === 0 ? (
                "None"
              ) : (
                <span className="row">
                  {otherVersions.map((seq) => (
                    <button
                      key={seq}
                      type="button"
                      disabled={busy}
                      onClick={() => chooseVersion(seq)}
                    >
                      Use version {seq} instead
                    </button>
                  ))}
                </span>
              )}
            </dd>
          </dl>
          {preview.verified ? null : (
            <Notice tone="bad">
              This backup does not pass its check, so it cannot be restored.
              Choose another version instead.
            </Notice>
          )}
          {preview.problems.map((problem, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: problems are not unique
            <Notice tone="warn" key={`${index}-${problem}`}>
              {problem}
            </Notice>
          ))}
          <details className="details">
            <summary>Files in this backup ({preview.files.length})</summary>
            <FileList files={preview.files} />
          </details>
          <Notice tone="warn">
            {sourceRetired
              ? `${client.name} stays disconnected. This creates a new code for the fresh device.`
              : `Restoring cuts off ${client.name}. Its access to this server ends when you confirm.`}
          </Notice>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to restore"
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div className="row">
            <button
              type="submit"
              className="danger"
              disabled={
                busy ||
                !preview.verified ||
                (!sourceRetired && !understood) ||
                !password
              }
            >
              {sourceRetired
                ? "Generate restore code"
                : `Restore and cut off ${client.name}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setError(undefined);
                setStage("explain");
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : null}

      {stage === "issued" && issued ? (
        <PairCode
          code={issued.code}
          expiresAt={toEpoch(issued.expiresAt) ?? 0}
          title="One-time code"
          codeLabel="Restore code"
          expiredText={`This code has expired, so it cannot be used. ${client.name} stays cut off.`}
          expiredLabel="Get a new code"
          doneLabel="I have entered it"
          onDone={onClose}
          onExpired={() => {
            setIssued(undefined);
            setStage("confirm");
          }}
          steps={
            <>
              <CopyButton label="restore code" text={issued.code} />
              <ol className="plain-steps">
                <li>
                  On the fresh device, open its homectl panel and go to{" "}
                  <strong>System</strong>.
                </li>
                <li>
                  In the workspace link, enter{" "}
                  {address ? (
                    <code>{address}</code>
                  ) : (
                    "the workspace server address"
                  )}{" "}
                  and paste this code into{" "}
                  <strong>One-time pairing code</strong>.
                </li>
                <li>
                  Enter that device's owner password and select{" "}
                  <strong>Pair with server</strong>. The device shows the
                  restore result.
                </li>
              </ol>
            </>
          }
        >
          <Notice tone="warn">
            {client.name} is cut off. Restoring to {issued.server.name} writes
            only files the fresh device does not already have.
          </Notice>
        </PairCode>
      ) : null}
    </Dialog>
  );
}
