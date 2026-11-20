// The workspace server's view: what waits on linked clients first, then the
// clients themselves, then how to add one. Every decision goes to the client,
// which applies it under its own approval policy; this page never runs anything.
import { useCallback, useState } from "react";
import { describeError } from "./api";
import { type ViewScope } from "./context";
import { ContextNote } from "./context-switcher";
import { ClientsSection } from "./workspace-clients";
import { InviteSection } from "./workspace-invite";
import { IntentHistory } from "./workspace-intents";
import { PendingSection } from "./workspace-pending";
import { RestoreFlow } from "./workspace-restore";
import {
  decideWorkspace,
  type WorkspaceClient,
  type WorkspaceDecision,
  type WorkspaceIntentRow,
  type WorkspacePending,
  type WorkspaceServerInfo,
} from "./workspace-api";
import { Notice } from "./ui";

export function WorkspaceScreen({
  server,
  clients,
  pending,
  intents,
  scope,
  onChanged,
  onError,
}: {
  server: WorkspaceServerInfo;
  // Already filtered to the device context in `scope`.
  clients: WorkspaceClient[];
  pending: WorkspacePending[];
  intents: WorkspaceIntentRow[];
  // The device context this view shows; absent means All devices.
  scope?: ViewScope;
  // Re-reads the server after a change, so every surface shows the same state.
  onChanged: () => Promise<void>;
  onError: (error: unknown) => unknown;
}) {
  // This device has no linked-client rows, so only the note is shown for it.
  const thisDevice = scope?.context.kind === "local";
  const wholeServer = scope === undefined || scope.context.kind === "all";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // The restore flow is held here, not in a client row: a restore revokes the
  // client, the row leaves the list, and the one-time code must stay on screen.
  const [restoring, setRestoring] = useState<
    { id: string; name: string } | undefined
  >();
  const closeRestore = useCallback(() => setRestoring(undefined), []);

  const decide = async (
    operation: WorkspacePending,
    decision: WorkspaceDecision,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // The queued decision comes back on the pending row after the re-read.
      await decideWorkspace({
        client: operation.origin,
        operationId: operation.id,
        fingerprint: operation.fingerprint,
        decision,
      });
      await onChanged();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
      // The list may have changed under us (decided elsewhere, expired).
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Devices &amp; backup</h2>
        <p>
          {server.name}. Decisions you make here go to the linked client, which
          applies them under its own approval rules. A client marked "Not synced
          lately" has not checked in recently, so what you see is its last known
          state.
        </p>
      </div>
      <ContextNote scope={scope} />
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {thisDevice ? (
        <p className="small muted">
          Linked clients, their approvals and their history are not shown for
          This device. Choose All devices or a client to see them.
        </p>
      ) : (
        <>
          <PendingSection
            pending={pending}
            clients={clients}
            busy={busy}
            onDecide={decide}
          />
          <IntentHistory intents={intents} clients={clients} />
          <ClientsSection
            clients={clients}
            busy={busy}
            onChanged={() => void onChanged()}
            onRestore={(client) =>
              setRestoring({ id: client.id, name: client.name })
            }
            onError={onError}
          />
        </>
      )}
      {wholeServer ? <InviteSection onError={onError} /> : null}
      {restoring ? (
        <RestoreFlow
          client={restoring}
          onClose={closeRestore}
          onRestored={() => void onChanged()}
          onError={onError}
        />
      ) : null}
    </>
  );
}
