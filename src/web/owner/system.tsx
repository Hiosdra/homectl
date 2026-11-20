// Panel-level settings: updates for this homectl, and browser notifications.
// Notification permission belongs to the browser; the panel only asks for it
// from a button press, and shows what the browser answered.
import { useState } from "react";
import { alertPermission, askForAlerts, type AlertPermission } from "./alerts";
import { UpdatePanel } from "./update-panel";
import { Badge, Notice } from "./ui";

export function SystemScreen({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  return (
    <>
      <div className="page-head">
        <h2>System</h2>
        <p>
          Updates for this homectl and whether this browser may tell you when
          something needs you.
        </p>
      </div>
      <UpdatePanel onError={onError} />
      <NotificationSection />
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
