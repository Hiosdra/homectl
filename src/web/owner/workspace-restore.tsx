// Restores a linked client's snapshot to a fresh device: the latest one, or an
// older version the owner picks by its number. Three steps, each visible: the
// version, reason and password, then what the snapshot holds, then the revoking
// confirmation. Only after that does the one-time code appear. The screen owns
// this component, so the code survives the client's row leaving the list when
// the restore revokes it.
import { type FormEvent, useCallback, useId, useState } from "react";
import { describeError } from "./api";
import { needsOwnerPassword } from "./auto-mode-api";
import { Badge, Dialog, Field, fmtTime, Notice, PasswordStep } from "./ui";
import {
  formatBytes,
  parseRestoreSeq,
  previewWorkspaceRestore,
  restoreWorkspaceClient,
  type WorkspaceRestoreIssued,
  type WorkspaceRestorePreview,
} from "./workspace-restore-api";

type Stage = "form" | "preview" | "issued";

export function RestoreFlow({
  client,
  onClose,
  onRestored,
  onError,
}: {
  // The client as it was when the restore started; the list may drop it later.
  client: { id: string; name: string };
  onClose: () => void;
  // Re-reads the server: the restored client is revoked and leaves the list.
  onRestored: () => void;
  onError: (error: unknown) => unknown;
}) {
  const baseId = useId();
  const [stage, setStage] = useState<Stage>("form");
  const [reason, setReason] = useState("");
  // The version as typed; blank is the latest. Checked before anything is sent.
  const [seqText, setSeqText] = useState("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<WorkspaceRestorePreview | undefined>();
  const [understood, setUnderstood] = useState(false);
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

  // Going back to the form with another version: the owner enters the password
  // again, because each request takes it out of the form.
  const chooseVersion = (seq: number) => {
    setSeqText(String(seq));
    setPreview(undefined);
    setError(undefined);
    setStage("form");
  };

  const showPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !seqCheck.ok) return;
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
          reason: reason.trim(),
          password: secret,
        }),
      );
      setUnderstood(false);
      setStage("preview");
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
    if (busy || !preview || !preview.verified || !understood) return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      setIssued(
        await restoreWorkspaceClient({
          client: client.id,
          seq: preview.seq,
          reason: reason.trim(),
          password: secret,
        }),
      );
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

  const title =
    stage === "issued" ? "Code for the fresh device" : `Restore ${client.name}`;

  // The other versions the server holds, oldest first, to choose from.
  const otherVersions = preview
    ? preview.seqs
        .filter((seq) => seq !== preview.seq)
        .sort((first, second) => first - second)
    : [];

  return (
    <Dialog title={title} onClose={dismiss}>
      {stage === "form" ? (
        <form className="stack" onSubmit={(event) => void showPreview(event)}>
          <Notice tone="warn">
            Restoring copies a backup of {client.name} to a fresh device and{" "}
            <strong>revokes {client.name}</strong>. By default it is the latest
            one; choose an older version by its number. Nothing changes until
            you confirm the restore after the preview.
          </Notice>
          <Field
            id={`${baseId}-reason`}
            label="Reason"
            hint="kept in the audit history"
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
            label="Version"
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
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to preview"
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={
                busy || reason.trim() === "" || !password || !seqCheck.ok
              }
            >
              Preview snapshot
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {stage === "preview" && preview ? (
        <form className="stack" onSubmit={(event) => void restore(event)}>
          <dl>
            <dt>Snapshot</dt>
            <dd>
              Version {preview.seq}, taken {fmtTime(preview.createdAt)},{" "}
              {formatBytes(preview.bytes)}
            </dd>
            <dt>Verification</dt>
            <dd>
              {preview.verified ? (
                <Badge tone="good">Verified</Badge>
              ) : (
                <Badge tone="bad">Not verified</Badge>
              )}
            </dd>
            <dt>Other versions held</dt>
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
                      Preview version {seq}
                    </button>
                  ))}
                </span>
              )}
            </dd>
          </dl>
          {preview.verified ? null : (
            <Notice tone="bad">
              This snapshot does not verify, so a restore would be refused.
              Nothing can be restored from it.
            </Notice>
          )}
          {preview.problems.map((problem, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: problems are not unique
            <Notice tone="warn" key={`${index}-${problem}`}>
              {problem}
            </Notice>
          ))}
          <FileList files={preview.files} />

          <Notice tone="warn">
            Restoring revokes {client.name}. Its access to this server ends when
            you confirm, and the revocations it reported are reapplied to the
            restored files. Files are written only to a device that has none of
            them yet.
          </Notice>
          <label className="row">
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            I understand {client.name} will be revoked.
          </label>
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
              disabled={busy || !preview.verified || !understood || !password}
            >
              Restore and revoke {client.name}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setError(undefined);
                setStage("form");
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : null}

      {stage === "issued" && issued ? (
        <div className="stack">
          <Notice tone="warn">
            Shown once. It admits one fresh device and expires{" "}
            {fmtTime(issued.expiresAt)}. {client.name} is revoked.
          </Notice>
          <pre className="copy" aria-label="Restore code">
            {issued.code}
          </pre>
          <p className="small">
            On the fresh device run{" "}
            <code>
              home-ctl workspace join &lt;server address&gt; &lt;code&gt;
            </code>{" "}
            before the code expires, and compare the verification phrase it
            shows. Restoring to {issued.server.name} writes only files the
            device does not already have.
          </p>
          <button type="button" onClick={onClose}>
            I have entered it
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

function FileList({ files }: { files: WorkspaceRestorePreview["files"] }) {
  if (files.length === 0)
    return <p className="small muted">The snapshot holds no files.</p>;
  return (
    <table>
      <caption className="small">Files in this snapshot</caption>
      <thead>
        <tr>
          <th scope="col">File</th>
          <th scope="col">Size</th>
          <th scope="col">On restore</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <tr key={file.path}>
            <td>{file.path}</td>
            <td>{formatBytes(file.size)}</td>
            <td>{file.restorable ? "Restored" : "Not restored"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
