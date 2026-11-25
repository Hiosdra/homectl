// Step bodies of the guided setup, part two: welcome, the vault, permissions, the
// optional devices and notifications, and the done page. Each body only describes
// the step and offers the one action that applies; the broker decides what is done.
import { useEffect, useRef, useState } from "react";
import { alertPermission, askForAlerts, type AlertPermission } from "./alerts";
import { Icon } from "./icons";
import { setupHash } from "./route";
import { markSetup, stepOf } from "./setup-api";
import { TerminalHint, UpgradeNotice } from "./setup-checklist";
import { wizardStep } from "./setup-copy";
import { DoneLine, type StepProps } from "./setup-steps";
import { WorkspaceJoinCard } from "./workspace-join";
import { Badge, Notice } from "./ui";

export function WelcomeBody({ status, onChanged, onError }: StepProps) {
  return (
    <>
      <UpgradeNotice status={status} onChanged={onChanged} onError={onError} />
      <p>
        homectl lets an AI assistant work on your machines, but never without
        your say-so. Each change waits for your approval, and each machine's
        access is one you pick.
      </p>
      <h4>What you need</h4>
      <ul className="plain-steps">
        <li>
          A private terminal on this computer, for the vault and the keys.
        </li>
        <li>This browser, which stays open while you set up.</li>
        <li>Claude or Codex, for the assistant you connect.</li>
      </ul>
      <p className="small muted">
        Setup takes about 15 minutes. Skip any step and come back to it later.
        Progress is saved on this computer's homectl, so a new browser keeps it.
      </p>
    </>
  );
}

export function VaultBody({ status }: StepProps) {
  const step = stepOf(status, "vault");
  const done = step.state === "done";
  return (
    <>
      {done ? (
        <DoneLine>Your vault exists, and you are signed in.</DoneLine>
      ) : (
        <p>
          Your vault is a password-protected file that holds your machines'
          keys. Create it once, in a private terminal:
        </p>
      )}
      {done ? null : (
        <TerminalHint
          label="setup command"
          command="home-ctl setup"
          note="It asks you to choose a vault password of at least 12 characters, then opens this panel."
        />
      )}
      <Notice tone="warn">
        <strong>The vault password is also your owner password.</strong> It
        signs you in here, and signing in also opens your vault. Write it down
        somewhere safe: nothing in the vault can be recovered without it.
      </Notice>
      <details className="setup-details">
        <summary>Details</summary>
        <p className="small muted">
          The panel signs you out after 15 minutes without use. Signing in again
          asks for the same password. Only the vault password can change a
          security setting, and each change asks for it again.
        </p>
        <p className="small muted">
          Already created the vault? Use <code>home-ctl session init</code>{" "}
          instead; it does the same job for the vault alone.
        </p>
      </details>
    </>
  );
}

export function PermissionsBody({ status, onChanged, onError }: StepProps) {
  const [busy, setBusy] = useState(false);
  const step = stepOf(status, "permissions");
  const done = step.state === "done";
  const keep = async () => {
    setBusy(true);
    try {
      onChanged(await markSetup({ action: "keep", step: "permissions" }));
    } catch (failure) {
      onError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {done ? (
        <DoneLine>
          {step.detected
            ? "Your permissions are saved."
            : "You kept “Ask me first”."}
        </DoneLine>
      ) : null}
      <p>
        Both choices below are equally valid. Pick the one that fits how you
        work.
      </p>
      <div className="setup-choices">
        <section className="setup-choice" aria-labelledby="keep-ask-title">
          <h3 id="keep-ask-title">Keep “Ask me first”</h3>
          <p className="small muted">
            Every change waits for your approval. This is the default.
          </p>
          <button type="button" onClick={keep} disabled={busy || done}>
            Keep “Ask me first”
          </button>
        </section>
        <section className="setup-choice" aria-labelledby="change-title">
          <h3 id="change-title">Choose something else</h3>
          <p className="small muted">
            Open Permissions to pick another level, or to set rules for the
            changes you trust.
          </p>
          <a className="button" href="#/policy">
            Open Permissions
          </a>
        </section>
      </div>
      <details className="setup-details">
        <summary>The AI helper (optional, later)</summary>
        <p className="small muted">
          The AI helper can take small, undoable fixes for you. It is optional
          and set up from Permissions, when you want it.
        </p>
      </details>
    </>
  );
}

export function DevicesBody({ status, onError }: StepProps) {
  const serving = status.facts.workspaceServer;
  const paired = status.facts.pairedDevices;
  return (
    <>
      {serving || paired > 0 ? (
        <DoneLine>
          {[
            serving ? "This computer serves your other devices." : "",
            paired > 0
              ? `${paired} ${paired === 1 ? "device is" : "devices are"} paired.`
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </DoneLine>
      ) : (
        <p>
          Optional. Pair another computer to keep encrypted backups of your
          inventory, known hosts, and policy there, and to approve requests from
          it. Only pair devices you own.
        </p>
      )}
      {serving ? null : <WorkspaceJoinCard onError={onError} />}
      <details className="setup-details">
        <summary>Details: backups</summary>
        <p className="small muted">
          Backups stay encrypted. Starting a restore needs the owner password on
          the workspace server. Backups appear in Devices &amp; backup once
          paired.
        </p>
      </details>
    </>
  );
}

export function NotificationsBody({ status, onChanged, onError }: StepProps) {
  const [permission, setPermission] = useState<AlertPermission>(() =>
    alertPermission(),
  );
  const [asking, setAsking] = useState(false);
  const step = stepOf(status, "notifications");
  const done = step.state === "done";

  // A permission granted in the browser is recorded once as this step's mark. The
  // mark changes no security state; it only remembers what the owner did.
  const recorded = useRef(false);
  useEffect(() => {
    if (permission !== "granted" || done || recorded.current) return;
    recorded.current = true;
    markSetup({ action: "done", step: "notifications" })
      .then(onChanged)
      .catch(onError);
  }, [permission, done, onChanged, onError]);

  const ask = async () => {
    if (asking) return;
    setAsking(true);
    try {
      setPermission(await askForAlerts());
    } finally {
      setAsking(false);
    }
  };

  return (
    <>
      {done || permission === "granted" ? (
        <DoneLine>Notifications are on for this browser.</DoneLine>
      ) : null}
      <p>
        Optional. Alerts tell you a request needs you, even when this tab is in
        the background. They name the assistant and the machine only.
      </p>
      {permission === "unsupported" ? (
        <Notice>This browser does not offer notifications.</Notice>
      ) : null}
      {permission === "default" ? (
        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={ask}
            disabled={asking}
          >
            <Icon name="bell" /> Allow alerts
          </button>
        </div>
      ) : null}
      {permission === "denied" ? (
        <Notice tone="warn">
          Alerts are blocked for this site. In your browser's site settings,
          allow notifications for this address, then reload this page.
        </Notice>
      ) : null}
      <h4>Start homectl when you sign in (optional)</h4>
      <TerminalHint
        label="startup command"
        command="home-ctl service install --task --interface <LAN-IP>"
        note="Replace <LAN-IP> with this computer's address on your network. It starts homectl when you sign in to Windows."
      />
      <h4>Versions</h4>
      <p className="small muted">
        See whether a newer homectl is out, and install it from System.{" "}
        <a href="#/system">Open System →</a>
      </p>
    </>
  );
}

export function DoneBody({ status, onChanged, onError }: StepProps) {
  const [busy, setBusy] = useState(false);
  const hide = async () => {
    setBusy(true);
    try {
      onChanged(await markSetup({ action: "dismiss" }));
    } catch (failure) {
      onError(failure);
    } finally {
      setBusy(false);
    }
  };
  if (!status.completed) {
    const left = status.next ? wizardStep(status.next) : undefined;
    return (
      <>
        <Notice tone="warn">
          Setup is not finished. Still needed:{" "}
          <strong>{left?.title ?? "some steps"}</strong>.
        </Notice>
        {status.next ? (
          <p>
            <a className="button primary" href={setupHash(status.next)}>
              Continue setup
            </a>
          </p>
        ) : null}
      </>
    );
  }
  return (
    <>
      <DoneLine>homectl is set up.</DoneLine>
      <p>
        Requests that need you appear in Needs you. You can come back here at
        any time.
      </p>
      <div className="row">
        <a className="button primary" href="#/">
          Open Needs you
        </a>
        {status.dismissed ? (
          <Badge tone="good">Checklist hidden</Badge>
        ) : (
          <button type="button" onClick={hide} disabled={busy}>
            Hide this checklist
          </button>
        )}
      </div>
    </>
  );
}
