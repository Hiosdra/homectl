// The workspace server's view: what waits on linked clients first, then the
// clients themselves, then how to add one. Every decision goes to the client,
// which applies it under its own approval policy; this page never runs anything.
import { useCallback, useState } from "react";
import { describeError } from "./api";
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
  onChanged,
  onError,
}: {
  server: WorkspaceServerInfo;
  clients: WorkspaceClient[];
  pending: WorkspacePending[];
  intents: WorkspaceIntentRow[];
  // Re-reads the server after a change, so every surface shows the same state.
  onChanged: () => Promise<void>;
  onError: (error: unknown) => unknown;
}) {
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
      <h2>Workspace</h2>
      <p className="small muted">
        {server.name}. Decisions here are sent to the client, which applies them
        under its own approval policy. A client marked stale has not synced
        recently, so its state is the last one mirrored here.
      </p>
      {error ? <Notice tone="bad">{error}</Notice> : null}
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
      <InviteSection onError={onError} />
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
