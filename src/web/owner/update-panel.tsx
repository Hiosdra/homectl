// Update status for this homectl, and an Update action only when the broker
// offers one. Without the update route the panel shows the build version and
// how to update from the command line. The owner confirms the exact version
// with the owner password; the broker verifies the signature before applying.
import { useEffect, useState } from "react";
import { describeError } from "./api";
import { PANEL_VERSION } from "./version";
import {
  applyUpdate,
  readUpdateStatus,
  releaseSentence,
  signatureLabel,
  type UpdateStatus,
} from "./update-api";
import { Badge, Dialog, Notice, PasswordStep } from "./ui";

type Load =
  | { state: "loading" }
  | { state: "absent" }
  | { state: "ready"; status: UpdateStatus }
  | { state: "failed"; message: string };

export function UpdatePanel({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  // The version an Update action would install; undefined hides the action.
  const offered =
    load.state === "ready" &&
    load.status.available &&
    load.status.canApply &&
    load.status.signature !== "failed"
      ? load.status.latest
      : undefined;

  const refresh = async () => {
    try {
      const status = await readUpdateStatus();
      setLoad(status ? { state: "ready", status } : { state: "absent" });
    } catch (failure) {
      onError(failure);
      setLoad({ state: "failed", message: describeError(failure) });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const apply = async (version: string) => {
    if (working) return;
    // Take the password out of the form before the request leaves.
    const secret = password;
    setPassword("");
    setWorking(true);
    setError(undefined);
    try {
      const applied = await applyUpdate(version, secret);
      setConfirming(false);
      setResult(
        `Update to ${version} requested (${applied.state}).${applied.next ? ` ${applied.next}` : ""}`,
      );
      await refresh();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section aria-labelledby="update-heading">
      <h3 id="update-heading">Updates</h3>
      <dl>
        <dt>This panel</dt>
        <dd>homectl {PANEL_VERSION}</dd>
        {load.state === "ready" ? (
          <>
            <dt>Installed</dt>
            <dd>homectl {load.status.current}</dd>
            <dt>Releases</dt>
            <dd>{releaseSentence(load.status)}</dd>
            <dt>Signature</dt>
            <dd>
              <Badge tone={signatureLabel(load.status.signature).tone}>
                {signatureLabel(load.status.signature).text}
              </Badge>
            </dd>
          </>
        ) : null}
      </dl>

      {load.state === "loading" ? <p className="muted">Checking…</p> : null}
      {load.state === "absent" ? (
        <p className="small muted">
          This broker does not report update status yet, so the panel cannot
          offer an update. Update from the command line with{" "}
          <code>home-ctl update</code>.
        </p>
      ) : null}
      {load.state === "failed" ? (
        <Notice tone="bad">{load.message}</Notice>
      ) : null}
      {result ? <Notice tone="good">{result}</Notice> : null}

      {offered !== undefined ? (
        <div className="stack">
          <p className="small muted">
            The broker verifies the signature and installs only this version.
            Nothing runs from the browser.
          </p>
          <button
            type="button"
            className="primary"
            disabled={working}
            onClick={() => setConfirming(true)}
          >
            Update to {offered}…
          </button>
        </div>
      ) : null}
      {load.state === "ready" && load.status.signature === "failed" ? (
        <Notice tone="bad">
          The signature of the available update did not verify, so it cannot be
          installed from here.
        </Notice>
      ) : null}
      {load.state === "ready" && !load.status.canApply ? (
        <Notice>
          {load.status.reason ??
            "This broker cannot update itself from the panel."}
        </Notice>
      ) : null}

      {confirming && offered !== undefined ? (
        <Dialog
          title={`Update to ${offered}?`}
          onClose={() => setConfirming(false)}
        >
          <p>
            Owner confirmation is required. The broker checks the signature
            before it installs {offered}.
          </p>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to update"
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={!password || working}
              onClick={() => void apply(offered)}
            >
              Update homectl
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
