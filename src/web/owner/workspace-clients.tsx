// Linked clients as the server mirrors them. Stale and offline are labelled
// plainly: the server shows the last mirrored state, not a live one.
import { useState } from "react";
import { describeError } from "./api";
import { removeWorkspaceClient, type WorkspaceClient } from "./workspace-api";
import { requestWorkspaceBackup } from "./workspace-restore-api";
import { Badge, Dialog, fmtTime, Notice, PasswordStep } from "./ui";

export function ClientsSection({
  clients,
  busy,
  onChanged,
  onRestore,
  onError,
}: {
  clients: WorkspaceClient[];
  busy: boolean;
  // Re-reads the server after a change to a client.
  onChanged: () => void;
  // Opens the restore flow for a client. The flow lives at screen level.
  onRestore: (client: WorkspaceClient) => void;
  onError: (error: unknown) => unknown;
}) {
  return (
    <section aria-labelledby="clients-heading">
      <h3 id="clients-heading">
        Linked clients <Badge tone="count">{clients.length}</Badge>
      </h3>
      {clients.length === 0 ? (
        <p className="muted">
          No client is linked yet. Add one below with an invite code.
        </p>
      ) : null}
      {clients.map((client) => (
        <ClientRow
          key={client.id}
          client={client}
          busy={busy}
          onChanged={onChanged}
          onRestore={onRestore}
          onError={onError}
        />
      ))}
    </section>
  );
}

export function ClientRow({
  client,
  busy,
  onChanged,
  onRestore,
  onError,
}: {
  client: WorkspaceClient;
  busy: boolean;
  onChanged: () => void;
  onRestore: (client: WorkspaceClient) => void;
  onError: (error: unknown) => unknown;
}) {
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [working, setWorking] = useState(false);
  const [asked, setAsked] = useState<string | undefined>();

  // One flag on the server: the client backs up at its next sync.
  const askForBackup = async () => {
    if (working) return;
    setWorking(true);
    setError(undefined);
    setAsked(undefined);
    try {
      await requestWorkspaceBackup(client.id);
      setAsked(
        `Asked ${client.name} to back up at its next sync (within 5 seconds while it is online).`,
      );
      onChanged();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    if (working) return;
    const secret = password;
    setPassword("");
    setWorking(true);
    setError(undefined);
    try {
      await removeWorkspaceClient(client.id, secret);
      setRemoving(false);
      onChanged();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setWorking(false);
    }
  };

  const backup = client.backup;
  return (
    <article className="item" aria-label={`Client ${client.name}`}>
      <div className="row between">
        <strong>{client.name}</strong>
        <Badge>{client.platform}</Badge>
      </div>
      <div className="row">
        <Badge tone={client.stale ? "warn" : "good"}>
          {client.stale ? "Not synced lately" : "Synced recently"}
        </Badge>
        <Badge tone={client.remoteApproval ? "good" : "neutral"}>
          {client.remoteApproval ? "Approvals here" : "Approvals on its device"}
        </Badge>
        <Badge tone={client.vaultUnlocked ? "good" : "neutral"}>
          {client.vaultUnlocked ? "Vault unlocked" : "Vault locked"}
        </Badge>
        {client.mirror.gaps > 0 ? (
          <Badge tone="bad">
            {client.mirror.gaps} missed{" "}
            {client.mirror.gaps === 1 ? "update" : "updates"}
          </Badge>
        ) : null}
      </div>
      <dl className="small">
        <dt>Last update</dt>
        <dd>
          Update {client.mirror.lastSeq}
          {client.mirror.gaps > 0
            ? ". Some updates were missed and cannot be shown here."
            : ""}
        </dd>
        <dt>Pending</dt>
        <dd>
          {client.pending === 0
            ? "Nothing waiting"
            : `${client.pending} waiting on the client`}
        </dd>
        <dt>Last backup</dt>
        <dd>
          {backup.latestAt === null
            ? "No backup yet"
            : `${fmtTime(backup.latestAt)} · version ${backup.latestSeq} · ${backup.count} kept`}
        </dd>
        <dt>Last synced</dt>
        <dd>
          {client.lastSeenAt === null ? "Never" : fmtTime(client.lastSeenAt)}
        </dd>
      </dl>
      {asked ? <Notice tone="good">{asked}</Notice> : null}
      {client.backupRequested && !asked ? (
        <p className="small muted">
          A backup was requested. It is taken at the next sync.
        </p>
      ) : null}
      {error && !removing ? <Notice tone="bad">{error}</Notice> : null}
      <div className="row">
        <button
          type="button"
          disabled={busy || working || client.backupRequested === true}
          onClick={() => void askForBackup()}
        >
          Request backup
        </button>
        <button
          type="button"
          disabled={busy || working}
          onClick={() => onRestore(client)}
        >
          Restore {client.name}…
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || working}
          onClick={() => setRemoving(true)}
        >
          Remove {client.name}…
        </button>
      </div>
      {removing ? (
        <Dialog
          title={`Remove ${client.name}?`}
          onClose={() => setRemoving(false)}
        >
          <p>
            It stops mirroring to this server and its waiting approvals are
            dropped here. It cannot rejoin this server with the same link.
          </p>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to remove"
          />
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div className="row">
            <button
              type="button"
              className="danger"
              disabled={!password || working}
              onClick={() => void remove()}
            >
              Remove client
            </button>
            <button type="button" onClick={() => setRemoving(false)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </article>
  );
}
