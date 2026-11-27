// Panel-level settings: updates for this homectl, and browser notifications.
// Notification permission belongs to the browser; the panel only asks for it
// from a button press, and shows what the browser answered.
import { useState } from "react";
import { alertPermission, askForAlerts, type AlertPermission } from "./alerts";
import { ApprovalWaitSection } from "./approval-wait";
import { SavedSecretGrants } from "./secret-grants";
import { type SetupStatus, stepOf } from "./setup-api";
import { SetupLink } from "./setup-checklist";
import { readTheme, type ThemePreference, writeTheme } from "./theme";
import { UpdatePanel } from "./update-panel";
import { WorkspaceJoinCard } from "./workspace-join";
import { Badge, Notice } from "./ui";

export function SystemScreen({
  onError,
  setup,
}: {
  onError: (error: unknown) => unknown;
  // The guided setup's progress, when the panel has it (it links the optional steps).
  setup?: SetupStatus;
}) {
  return (
    <>
      <div className="page-head">
        <h2>System</h2>
        <p>Appearance, approval timing, updates and browser notifications.</p>
      </div>
      <AppearanceSection />
      <ApprovalWaitSection onError={onError} />
      <SavedSecretGrants onError={onError} />
      <UpdatePanel onError={onError} />
      <NotificationSection />
      {setup && !setup.facts.workspaceServer ? (
        <WorkspaceJoinCard onError={onError} />
      ) : null}
      {setup && stepOf(setup, "notifications").state !== "done" ? (
        <p className="small muted">
          <SetupLink step="notifications">
            Set up alerts and updates, step by step →
          </SetupLink>
        </p>
      ) : null}
    </>
  );
}

export function NotificationSection() {
  const [permission, setPermission] = useState<AlertPermission>(() =>
    alertPermission(),
  );
  const [asking, setAsking] = useState(false);

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
    <section aria-labelledby="alerts-heading">
      <h3 id="alerts-heading">Notifications</h3>
      <p className="small muted">
        A notification appears when a new approval or secret request arrives
        while this panel is connected. It names the assistant and the machine
        only. It never shows the command, the assistant's explanation or any
        secret.
      </p>
      {permission === "unsupported" ? (
        <Notice>This browser does not offer notifications.</Notice>
      ) : null}
      {permission === "default" ? (
        <div className="row">
          <Badge>Not turned on</Badge>
          <button
            type="button"
            className="primary"
            disabled={asking}
            onClick={() => void ask()}
          >
            Turn on notifications
          </button>
        </div>
      ) : null}
      {permission === "granted" ? (
        <div className="row">
          <Badge tone="good">On</Badge>
        </div>
      ) : null}
      {permission === "denied" ? (
        <Notice tone="warn">
          Notifications are blocked for this site in the browser. Allow them in
          the browser's site settings, then reload this panel.
        </Notice>
      ) : null}
    </section>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearanceSection() {
  const [theme, setTheme] = useState<ThemePreference>(() => readTheme());
  const choose = (next: ThemePreference) => {
    setTheme(next);
    writeTheme(next);
  };
  return (
    <section aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">Appearance</h3>
      <p className="small muted">
        Choose how this panel looks in this browser. System follows your device
        setting.
      </p>
      <div className="segmented" role="group" aria-label="Theme">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={theme === option.value ? "active" : ""}
            aria-pressed={theme === option.value}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
