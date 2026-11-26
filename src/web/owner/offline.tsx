// The panel when the homectl broker is not running (audit 3.5): one plain sentence,
// the command to start it with a copy button, and a retry. Nothing here is a secret.
import { CopyButton } from "./copy";
import { Notice } from "./ui";

export function OfflineScreen({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="center">
      <section className="stack">
        <h2>homectl is not running</h2>
        <p>
          Start it in a terminal you keep open, then press Try again. This is
          the command:
        </p>
        <p>
          <code>home-ctl start</code>{" "}
          <CopyButton label="command" text="home-ctl start" primary />
        </p>
        <Notice tone="warn">{message}</Notice>
        <p className="small muted">
          This panel only forwards owner requests to the broker and holds
          nothing itself. It opens again once homectl is running.
        </p>
        <button type="button" className="primary" onClick={onRetry}>
          Try again
        </button>
      </section>
    </div>
  );
}
