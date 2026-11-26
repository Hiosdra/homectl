// Client-side workspace pairing and sync UI (homelab #21 §6). Lets the owner
// join a workspace server, trigger sync/backup, or unlink completely from the
// browser without needing the CLI.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { describeError, ownerCall } from "./api";
import { relativeTime } from "./time";
import { Badge, Field, Notice, PasswordStep } from "./ui";

interface ClientWorkspaceStatus {
  clientId: string;
  linked: boolean;
  server: { id: string; name: string; address: string } | null;
  remoteApproval: boolean;
  backupKeyRegistered: boolean;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  backup: { seq: number; lastAt: number | null; lastError: string | null };
}

interface JoinReply {
  server: { id: string; name: string };
  sas: string;
  backupKey: "registered" | "pending";
  restore?: {
    status: "none" | "restored" | "refused" | "failed";
    seq?: number;
    files?: string[];
    notes?: string[];
    acknowledged?: boolean;
    reason?: string;
  };
}

export function WorkspaceJoinCard({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [status, setStatus] = useState<ClientWorkspaceStatus>();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [remoteApproval, setRemoteApproval] = useState(false);
  const [password, setPassword] = useState("");
  const [leavePassword, setLeavePassword] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [restore, setRestore] = useState<JoinReply["restore"]>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      setStatus(
        await ownerCall<ClientWorkspaceStatus>("/v1/owner/workspace/status"),
      );
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const join = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !address.trim() || !code.trim() || !password) return;
    const secret = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setRestore(undefined);
    try {
      const joined = await ownerCall<JoinReply>("/v1/owner/workspace/join", {
        address: address.trim(),
        code: code.trim(),
        remoteApproval,
        password: secret,
      });
      setCode("");
      setRestore(joined.restore);
      if (joined.restore?.status !== "refused")
        setNotice(
          `Linked to ${joined.server.name}. Verification phrase: ${joined.sas}`,
        );
      await load();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const action = async (path: string, label: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setRestore(undefined);
    try {
      const result = await ownerCall<ClientWorkspaceStatus & { run?: unknown }>(
        path,
      );
      setNotice(result.run === null ? "No new backup was created." : label);
      setError(undefined);
      setStatus(result);
      await load();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const leave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !leavePassword) return;
    const secret = leavePassword;
    setLeavePassword("");
    setBusy(true);
    setError(undefined);
    try {
      await ownerCall("/v1/owner/workspace/leave", { password: secret });
      setLeaving(false);
      setNotice("Unlinked from workspace server.");
      await load();
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack" aria-labelledby="ws-client-heading">
      <div className="row between">
        <h3 id="ws-client-heading">This device's workspace link</h3>
        {status ? (
          <Badge tone={status.linked ? "good" : "neutral"}>
            {status.linked ? "Linked" : "Standalone"}
          </Badge>
        ) : null}
      </div>
      {notice ? <Notice tone="good">{notice}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {restore?.status === "restored" ? (
        <Notice tone={restore.acknowledged ? "good" : "warn"}>
          <p>
            Restored snapshot {restore.seq}. Check the inventory before using
            this device.
          </p>
          {restore.files?.length ? <p>{restore.files.join(", ")}</p> : null}
          <p>
            {restore.acknowledged
              ? "The server confirmed the restore."
              : "Waiting for the server to confirm the restore. This device retries on its next sync."}
          </p>
          {restore.notes?.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </Notice>
      ) : null}
      {restore?.status === "refused" || restore?.status === "failed" ? (
        <Notice tone="bad">Restore did not complete. {restore.reason}</Notice>
      ) : null}
      {!status ? (
        error ? (
          <button type="button" onClick={() => void load()}>
            Retry link status
          </button>
        ) : (
          <p className="muted">Loading link status…</p>
        )
      ) : status.linked && status.server ? (
        <>
          <dl>
            <dt>Server</dt>
            <dd>
              <strong>{status.server.name}</strong>{" "}
              <span className="mono">{status.server.address}</span>
            </dd>
            <dt>Remote approvals</dt>
            <dd>{status.remoteApproval ? "Allowed" : "Local device only"}</dd>
            <dt>Last sync</dt>
            <dd>
              {status.lastSyncAt
                ? relativeTime(status.lastSyncAt)
                : "Not synced yet"}
            </dd>
            <dt>Latest backup</dt>
            <dd>
              {status.backup.seq > 0
                ? `#${status.backup.seq}${status.backup.lastAt ? ` · ${relativeTime(status.backup.lastAt)}` : ""}`
                : "No backup yet"}
            </dd>
          </dl>
          {!status.backupKeyRegistered ? (
            <Notice tone="warn">Backup key registration is pending.</Notice>
          ) : null}
          {status.backup.lastError ? (
            <Notice tone="warn">{status.backup.lastError}</Notice>
          ) : null}
          {status.lastSyncError ? (
            <Notice tone="warn">{status.lastSyncError}</Notice>
          ) : null}
          <div className="request-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void action("/v1/owner/workspace/sync-now", "Synced now.")
              }
            >
              Sync now
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(
                  "/v1/owner/workspace/backup-now",
                  "Encrypted backup finished.",
                )
              }
            >
              Back up now
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => setLeaving((prev) => !prev)}
            >
              Unlink
            </button>
          </div>
          {leaving ? (
            <form className="stack" onSubmit={leave}>
              <PasswordStep
                value={leavePassword}
                onChange={setLeavePassword}
                hint="required to unlink this device"
              />
              <div className="request-actions">
                <button
                  type="submit"
                  className="danger"
                  disabled={busy || !leavePassword}
                >
                  Confirm unlink
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setLeaving(false);
                    setLeavePassword("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : (
        <form className="stack" onSubmit={join}>
          <p className="small muted">
            Pair this device with a homectl workspace server (such as your NAS)
            for encrypted backups and central approvals.
          </p>
          <Field
            id="ws-join-address"
            label="Workspace server address"
            hint="shown on the server's Devices & backup page"
          >
            <input
              id="ws-join-address"
              type="url"
              placeholder="http://nas.local:7450"
              value={address}
              required
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <Field
            id="ws-join-code"
            label="One-time pairing code"
            hint="from the server's Devices & backup page"
          >
            <input
              id="ws-join-code"
              type="text"
              placeholder="1234-5678"
              value={code}
              required
              autoComplete="off"
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
          <label className="row">
            <input
              type="checkbox"
              checked={remoteApproval}
              onChange={(event) => setRemoteApproval(event.target.checked)}
            />
            <span>Allow approvals and secret forms from this server</span>
          </label>
          <PasswordStep
            value={password}
            onChange={setPassword}
            hint="required to link this device"
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !address.trim() || !code.trim() || !password}
          >
            {busy ? "Pairing…" : "Pair with server"}
          </button>
        </form>
      )}
    </section>
  );
}
