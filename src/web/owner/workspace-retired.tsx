import { useEffect, useState } from "react";
import { describeError } from "./api";
import { fmtTime, Notice } from "./ui";
import {
  listRetiredWorkspaceClients,
  type RetiredWorkspaceClient,
} from "./workspace-api";

export function RetiredBackups({
  linkedCount,
  onRestore,
  onError,
}: {
  linkedCount: number;
  onRestore: (client: RetiredWorkspaceClient) => void;
  onError: (error: unknown) => unknown;
}) {
  const [clients, setClients] = useState<RetiredWorkspaceClient[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setError(undefined);
    void listRetiredWorkspaceClients().then(
      (rows) => {
        if (current) setClients(rows.filter((row) => row.restorable));
      },
      (failure: unknown) => {
        if (!current) return;
        onError(failure);
        setError(describeError(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [linkedCount, onError]);

  if (clients.length === 0 && !error) return null;
  return (
    <section aria-labelledby="retired-backups-heading">
      <h3 id="retired-backups-heading">Backups from disconnected devices</h3>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {clients.map((client) => (
        <article
          key={client.id}
          className="item"
          aria-label={`Backup from ${client.name}`}
        >
          <div className="row between">
            <strong>{client.name}</strong>
            <button type="button" onClick={() => onRestore(client)}>
              Restore {client.name}…
            </button>
          </div>
          <p className="small muted">
            Disconnected {fmtTime(client.retiredAt)}
          </p>
        </article>
      ))}
    </section>
  );
}
