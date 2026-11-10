import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
export {};
type Machine = {
  description: string;
  transport: string;
  address?: string;
  user?: string;
  access: string;
  auth?: unknown;
  [key: string]: unknown;
};
type Permissions = {
  sync: boolean;
  diagnostics: boolean;
  operations: string[];
  administer: boolean;
};
type Peer = {
  id: string;
  name: string;
  platform: string;
  address: string;
  permissions: Permissions;
};
type State = {
  device: { id: string; name: string; platform: string };
  session: { unlocked: boolean; expiresAt?: number | null };
  vaultUnlocked: boolean;
  vaultExists: boolean;
  inventory: {
    machines: Record<string, Machine>;
    session?: { ttl: string; database: string };
  };
  peers: Peer[];
  pair: null | {
    code?: string;
    sas?: string;
    remote?: { name: string };
    expiresAt: number;
    localConfirmed: boolean;
    remoteConfirmed: boolean;
  };
  discovery: { devices: { id: string; address: string }[]; error?: string };
  pending: { id: string; peerId: string; remoteName: string }[];
  address: string;
  operations: {
    id: string;
    peerName: string;
    host: string;
    argv: string[];
    impact?: string;
  }[];
};
type Preview = {
  id: string;
  localName: string;
  remoteName: string;
  blocker?: { type: "remote_vault_locked" };
  changes: string[];
  entries?: {
    id: string;
    local: { value: unknown } | null;
    remote: { value: unknown };
  }[];
  conflicts: {
    id: string;
    local: { value: unknown };
    remote: { value: unknown };
  }[];
};
let state: State;
let preview: Preview | undefined;
let syncPeerId: string | undefined;
let syncWaiting: { peerId: string; previewId: string } | undefined;
let syncPoll = false;
let syncPollAfter = 0;
let view = "machines";
let editing: string | undefined;
let result: unknown;
let busy = false;
let pairingPoll = false;
let permissionPeer: string | undefined;
let commandHost: string | undefined;
let commandPeer = "";
let operationResult: { id: string; peerId: string } | undefined;
let remoteHosts:
  | {
      peerId: string;
      hosts: { name: string; description: string; access: string }[];
    }
  | undefined;

type ControlOp = {
  operationId: string;
  state: string;
  host: string;
  classification: string;
  needsApproval: boolean;
  fingerprint: string;
  argv: string[];
  impact: string;
  issuer: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  expired: boolean;
  approval?: { approver: string; expiresAt: string; state: string };
  spawnAttempted: boolean;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  reason?: string;
  remote?: boolean;
  ownerName?: string;
  runsOn?: string;
  conflict?: boolean;
  takeover?: { possible: boolean; reason?: string; at?: string };
  delivery?: {
    decision: "approve" | "reject";
    status: "awaiting-confirmation" | "approved" | "rejected";
    ownerName: string;
    since: string;
  };
  approvedBy?: string;
  offerTo?: string;
  offerFrom?: string;
  offerExpires?: string;
};
type ControlSync = {
  running: boolean;
  disabledBy?: string;
  peers: {
    id: string;
    name: string;
    lastSync?: number;
    leaseOk: boolean;
    excluded?: boolean;
    suspended?: { by: string; at: string; reason?: string };
    refused?: string;
    failures?: number;
    nextAttemptAt?: number;
    lastError?: string;
  }[];
  blocked: Record<string, string>;
  conflicts: { opId: string; epoch: number; candidates: string[] }[];
  resolutions?: {
    opId: string;
    conflictEpoch: number;
    winner: string;
    resolver: string;
    waitingForSelf?: boolean;
  }[];
  names?: Record<string, string>;
};
type ControlDevices = {
  self: { id: string; name: string; fingerprint?: string };
  peers: { id: string; name: string; fingerprint?: string; legacy: boolean }[];
};
type ControlAudit = {
  ok: boolean;
  entries: number;
  head: string;
  checkedAt?: string;
  error?: string;
};
type ControlClient = {
  id: string;
  name: string;
  scopes: string[];
  hosts: string[];
  createdAt: string;
  revoked: boolean;
  oidc?: {
    issuerHost: string;
    claim: "sub" | "client_id";
    identityHash: string;
  };
  hasToken: boolean;
};
// Read-only view of the OIDC configuration (no secrets, no subjects).
type OidcOverview = {
  issuer: string;
  issuerHost: string;
  audience: string;
  jwks: "configured" | "discovery";
  jwksHost?: string;
  maxLifetimeSeconds: number;
  keyCount: number;
  refreshedAt?: string;
  lastError?: string;
  mappedClients: number;
};
type ControlOverview = {
  operations: ControlOp[];
  clients: ControlClient[];
  audit: ControlAudit;
  sync?: ControlSync;
  devices?: ControlDevices;
  oidc?: OidcOverview;
};
type ControlExecution = {
  operation: ControlOp;
  output?: { stdout: string; stderr: string };
};
let control: ControlOverview | undefined;
let controlTab: "queue" | "clients" = "queue";
let controlFilter: ControlBucket = "ready";
let controlResult: ControlExecution | undefined;
// Operation whose handoff picker is open (owner side).
let handoffPicker: string | undefined;
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing ${id}`);
  return e as T;
}

function displayArgv(argv: string[]) {
  return argv.map((arg) => JSON.stringify(arg)).join(" ");
}
const sessionTtlPresets = [
  ["1h", "1 hour"],
  ["12h", "12 hours"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["until-reboot", "Until this computer restarts"],
] as const;
function sessionTtlLabel(value: string) {
  if (value === "until-reboot") return "Until this computer restarts";
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) return value;
  const units: Record<string, [string, string]> = {
    s: ["second", "seconds"],
    m: ["minute", "minutes"],
    h: ["hour", "hours"],
    d: ["day", "days"],
  };
  const unit = units[match[2] ?? ""];
  return unit
    ? `${match[1]} ${Number(match[1]) === 1 ? unit[0] : unit[1]}`
    : value;
}

function accessLabel(value: string) {
  return (
    {
      observe: "Read-only",
      user: "Standard user",
      "sudo-approved": "Approved admin commands",
      full: "Full account access",
    }[value] ?? value
  );
}
function formatLocalDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
function pairingAddress() {
  try {
    const peer = new URL(state.address);
    const panel = new URL(location.origin);
    if (
      panel.hostname !== "127.0.0.1" &&
      panel.hostname !== "localhost" &&
      panel.hostname !== "[::1]"
    ) {
      panel.protocol = "http:";
      panel.port = peer.port || "7448";
      panel.pathname = "/";
      panel.search = "";
      panel.hash = "";
      return panel.origin;
    }
    return peer.origin;
  } catch {
    return state.address;
  }
}

async function api<T = unknown>(path: string, value?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: value === undefined ? "GET" : "POST",
    headers: value === undefined ? {} : { "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  let v: Record<string, unknown>;
  try {
    v = (await r.json()) as Record<string, unknown>;
  } catch {
    throw new Error(
      r.ok
        ? "The workspace returned an unreadable response. Refresh and try again."
        : `The workspace could not complete this request (${r.status}). Refresh and try again.`,
    );
  }
  if (!r.ok)
    throw new Error(
      typeof v.error === "string" ? v.error : "The operation failed.",
    );
  return v as T;
}

async function copyText(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied)
    throw new Error("Copy failed. Select the text and copy it manually.");
}

type ControlBucket = "ready" | "needs" | "history";
function isReady(op: ControlOp) {
  return (
    op.state === "approved" || (op.state === "pending" && !op.needsApproval)
  );
}
function bucketOf(op: ControlOp): ControlBucket {
  if (isReady(op)) return "ready";
  if (op.state === "pending") return "needs";
  return "history";
}
function rankOf(op: ControlOp) {
  const bucket = bucketOf(op);
  if (bucket === "ready") return 0;
  if (bucket === "needs") return 1;
  return op.state === "executing" ? 2 : 3;
}
function labelOf(op: ControlOp) {
  return op.state === "failed" &&
    (op.reason === "plan-expired" || op.reason === "approval-expired")
    ? "expired"
    : op.state;
}
// What a person should read at a glance; the stored state is unchanged.
function displayStateOf(op: ControlOp) {
  const label = labelOf(op);
  if (label === "expired") return "expired";
  if (op.state === "pending")
    return op.needsApproval ? "needs approval" : "ready";
  if (op.state === "approved") return "ready";
  return op.state;
}

function formatMs(ms: number) {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const total = Math.round(ms / 1_000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}
function durationText(op: ControlOp) {
  if (!op.startedAt || !op.finishedAt) return undefined;
  return formatMs(Date.parse(op.finishedAt) - Date.parse(op.startedAt));
}
function span(ms: number) {
  const a = Math.abs(ms);
  if (a < 60_000) return "<1 min";
  if (a < 3_600_000) return `${Math.round(a / 60_000)} min`;
  if (a < 86_400_000) return `${Math.round(a / 3_600_000)} h`;
  return `${Math.round(a / 86_400_000)} d`;
}
function relative(iso: string, expiry = false) {
  const delta = Date.parse(iso) - Date.now();
  if (expiry)
    return delta >= 0
      ? `expires in ${span(delta)}`
      : `expired ${span(delta)} ago`;
  return delta >= 0 ? `in ${span(delta)}` : `${span(delta)} ago`;
}
function localStamp(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function shellArgv(argv: string[]) {
  return argv
    .map((arg) =>
      /^[A-Za-z0-9_/.:=@%+,-]+$/.test(arg)
        ? arg
        : `'${arg.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}
function shortHash(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

// Takeover is shown with its earliest time, or the reason it is unavailable.
function takeoverText(op: ControlOp) {
  const t = op.takeover;
  if (!t) return "";
  if (t.possible) return "Takeover available";
  if (t.at) return `Takeover possible after ${localStamp(t.at)}`;
  return t.reason ?? "Takeover unavailable";
}

// "offer expires in 12 min" or "offer expired 2 min ago".
function offerExpiry(op: ControlOp) {
  return op.offerExpires ? `offer ${relative(op.offerExpires, true)}` : "";
}

// ---- React store: every change to the shared state goes through render() ----
let version = 0;
let focusPending = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function snapshot() {
  return version;
}
function render() {
  version += 1;
  for (const listener of listeners) listener();
}
// Moves focus to the screen heading (or the result card) after a user action.
function focusScreen() {
  focusPending = true;
  render();
}

let connected = false;
let banners: { error?: string; notice?: string; connection?: string } = {};
let announcement = "";
let filterText = "";
let conflictChoice: Record<number, string | undefined> = {};
let syncWaitStatus =
  "Waiting for the vault. This comparison updates automatically when it is unlocked.";
let confirmRequest:
  | {
      title: string;
      body: ReactNode;
      resolve: (ok: boolean) => void;
      returnTo?: HTMLElement;
    }
  | undefined;
let unlockRequest:
  | { resolve: (ok: boolean) => void; error?: string; submitting: boolean }
  | undefined;

function report(message: string, kind = "error") {
  if (kind === "notice") banners = { ...banners, notice: message };
  else if (!connected) banners = { ...banners, connection: message };
  else banners = { ...banners, error: message };
  render();
}

// Opens the vault-unlock dialog for the sync flow; resolves when it closes.
function unlockForSync(): Promise<boolean> {
  return new Promise((resolve) => {
    unlockRequest = { resolve, submitting: false };
    render();
  });
}
function closeUnlock(ok: boolean) {
  const request = unlockRequest;
  unlockRequest = undefined;
  render();
  request?.resolve(ok);
}

// The confirmation dialog. Plain text, or JSX details built by the caller.
function confirm(title: string, description: string, body?: ReactNode) {
  const returnTo =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  return new Promise<boolean>((resolve) => {
    confirmRequest = {
      title,
      body: body ?? description,
      returnTo,
      resolve: (ok) => {
        confirmRequest = undefined;
        render();
        resolve(ok);
        // The opener is re-enabled when its task finishes; restore focus after that.
        setTimeout(() => {
          if (returnTo?.isConnected && !(returnTo as HTMLButtonElement).disabled)
            returnTo.focus();
        }, 0);
      },
    };
    render();
  });
}

function announce(message: string) {
  announcement = message;
  render();
}

function syncWaitVisible() {
  return syncWaiting !== undefined && syncWaiting.previewId === preview?.id;
}

function armSyncWait(next: Preview) {
  syncWaiting =
    next.blocker?.type === "remote_vault_locked" && syncPeerId
      ? { peerId: syncPeerId, previewId: next.id }
      : undefined;
  syncPollAfter = 0;
  conflictChoice = {};
}

async function updateSyncPreview(peerId: string) {
  const old = preview;
  const next = await api<Preview>("/api/sync/start", { id: peerId });
  // Navigation or another action can change the selected device while the
  // network request is in flight. Never replace that newer view.
  if (syncPeerId !== peerId || view !== "sync") {
    await api("/api/sync/cancel", { id: next.id }).catch(() => {});
    return false;
  }
  preview = next;
  armSyncWait(next);
  if (old && old.id !== next.id)
    await api("/api/sync/cancel", { id: old.id }).catch(() => {});
  render();
  return true;
}

async function task(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  banners = {};
  render();
  try {
    await fn();
  } catch (e) {
    if (
      e instanceof Error &&
      e.message === "Unlock the local vault before accepting credential changes"
    ) {
      if (await unlockForSync()) {
        await refresh();
        if (syncPeerId && view === "sync") {
          try {
            if ((await updateSyncPreview(syncPeerId)) && !syncWaiting)
              report(
                "Vault unlocked. Review the updated changes before applying them.",
                "notice",
              );
          } catch (error) {
            report(
              error instanceof Error
                ? error.message
                : "Could not update the comparison. Try again.",
            );
          }
        } else report("Vault unlocked. Choose a device to compare.", "notice");
      }
      return;
    }
    if (
      e instanceof Error &&
      e.message ===
        "The other device's vault was locked when the devices were compared. Unlock it there and compare again." &&
      preview &&
      syncPeerId
    ) {
      syncWaiting = { peerId: syncPeerId, previewId: preview.id };
      syncPollAfter = 0;
      render();
      return;
    }
    report(
      e instanceof Error
        ? e.message
        : "The operation failed. Refresh the workspace and try again.",
    );
  } finally {
    busy = false;
    focusScreen();
  }
}

async function pollSyncReadiness() {
  const waiting = syncWaiting;
  if (
    !waiting ||
    syncPoll ||
    busy ||
    view !== "sync" ||
    document.visibilityState !== "visible" ||
    Date.now() < syncPollAfter
  )
    return;
  syncPoll = true;
  try {
    const readiness = await api<{ vaultUnlocked: boolean }>(
      "/api/sync/readiness",
      { id: waiting.peerId },
    );
    if (
      syncWaiting !== waiting ||
      preview?.id !== waiting.previewId ||
      view !== "sync" ||
      busy
    )
      return;
    if (!readiness.vaultUnlocked) {
      syncPollAfter = Date.now() + 5000;
      return;
    }
    await task(async () => {
      if (syncWaiting !== waiting || preview?.id !== waiting.previewId) return;
      if ((await updateSyncPreview(waiting.peerId)) && !syncWaiting)
        report(
          "The other vault is unlocked. Review the updated changes before applying them.",
          "notice",
        );
    });
  } catch {
    if (syncWaiting === waiting && view === "sync") {
      syncPollAfter = Date.now() + 10_000;
      syncWaitStatus =
        "Can't reach the other device yet. Retrying automatically; you can also compare again.";
      render();
    }
  } finally {
    syncPoll = false;
  }
}

async function refresh() {
  state = await api<State>("/api/state");
  connected = true;
  control = await api<ControlOverview>("/api/control").catch(() => undefined);
  render();
}

async function pollPairing() {
  if (
    busy ||
    pairingPoll ||
    view !== "peers" ||
    !state?.pair ||
    document.visibilityState !== "visible"
  )
    return;
  pairingPoll = true;
  try {
    const current = state.pair;
    if (current.sas && current.localConfirmed && !current.remoteConfirmed)
      await api("/api/pair/poll", {});
    const next = await api<State>("/api/state");
    const before = JSON.stringify({
      pair: state.pair,
      peers: state.peers,
      discovery: state.discovery,
    });
    const after = JSON.stringify({
      pair: next.pair,
      peers: next.peers,
      discovery: next.discovery,
    });
    state = {
      ...state,
      pair: next.pair,
      peers: next.peers,
      discovery: next.discovery,
    };
    if (before !== after) render();
  } catch {
    // Pairing is time-limited; a later poll or the visible error from a user action is clearer.
  } finally {
    pairingPoll = false;
  }
}

function navigate(next: string) {
  view = next;
  // Banners describe the view that produced them; they do not follow the user.
  banners = { connection: banners.connection };
  editing = undefined;
  permissionPeer = undefined;
  commandHost = undefined;
  commandPeer = "";
  remoteHosts = undefined;
  result = undefined;
  filterText = "";
  location.hash = next;
  focusScreen();
}

// ---- Shared components ----
function Btn({
  action,
  label,
  id = "",
  kind = "secondary",
}: {
  action: string;
  label: ReactNode;
  id?: string;
  kind?: string;
}) {
  return (
    <button
      type="button"
      className={kind}
      data-action={action}
      data-id={id}
      disabled={busy}
    >
      {label}
    </button>
  );
}

function Heading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="actions">{actions}</div>
    </div>
  );
}

function SigningNote({ id }: { id: string }) {
  const device = control?.devices?.peers.find((p) => p.id === id);
  if (!device)
    return <p className="inline-note">Signing key not reported yet.</p>;
  return device.legacy ? (
    <p className="inline-note">
      Re-pair this device to enable control sync; it has no signing key.
    </p>
  ) : (
    <p className="inline-note">
      Signing key <code>{device.fingerprint ?? ""}</code>
    </p>
  );
}

function PermissionPanel({ id }: { id: string }) {
  const p = state.peers.find((x) => x.id === id);
  if (!p) return null;
  return (
    <>
      <Heading
        title={`Permissions: ${p.name}`}
        description="These grants define what this peer can do on this computer."
      />
      <section className="panel">
        <form id="permissions-form" key={id}>
          <label htmlFor="permission-address">Peer address</label>
          <input
            id="permission-address"
            name="address"
            defaultValue={p.address}
            required
          />
          <label className="check">
            <input
              name="sync"
              type="checkbox"
              defaultChecked={p.permissions.sync}
            />
            Sync entries
          </label>
          <label className="check">
            <input
              name="diagnostics"
              type="checkbox"
              defaultChecked={p.permissions.diagnostics}
            />
            Inspect this device and its hosts
          </label>
          <label className="check">
            <input
              name="administer"
              type="checkbox"
              defaultChecked={p.permissions.administer}
            />
            Operate on the computer running homectl
          </label>
          <h3 className="section">Hosts available for operations</h3>
          {Object.entries(state.inventory.machines).map(([name, m]) => (
            <label className="check" key={name}>
              <input
                name="hosts"
                value={name}
                type="checkbox"
                defaultChecked={p.permissions.operations.includes(name)}
              />
              {name} <span className="muted">{accessLabel(m.access)}</span>
            </label>
          ))}
          <p className="inline-note">
            Changes require additional approval here, on the execution device.
          </p>
          <div className="form-actions">
            <Btn action="close-task" label="Cancel" />
            <button className="primary">Save permissions</button>
          </div>
        </form>
      </section>
    </>
  );
}

function CommandPanel({ host }: { host: string }) {
  return (
    <>
      <Heading
        title={`Command: ${host}`}
        description="Choose where it runs and review the effect before anything changes."
      />
      <section className="panel">
        <form id="command-form" className="stack" key={host}>
          <div>
            <label htmlFor="command-peer">Run on</label>
            <select
              id="command-peer"
              name="peer"
              defaultValue={commandPeer}
            >
              <option value="">{state.device.name} · this computer</option>
              {state.peers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="command-program">Program</label>
            <input
              id="command-program"
              name="program"
              defaultValue="uname"
              required
            />
          </div>
          <div>
            <label htmlFor="command-arguments">
              Arguments (one per line)
            </label>
            <textarea id="command-arguments" name="arguments" defaultValue="-s" />
            <p className="inline-note">
              Each line is passed as one argument. Homectl does not run a shell.
            </p>
          </div>
          <div>
            <label htmlFor="command-impact">What should this do?</label>
            <input
              id="command-impact"
              name="impact"
              defaultValue="Inspect the operating system"
              required
            />
          </div>
          <p className="inline-note">
            The other device must grant access to this host. Changes also need
            approval there.
          </p>
          <div className="form-actions">
            <Btn action="close-task" label="Cancel" />
            <button className="primary">Review command</button>
          </div>
        </form>
      </section>
      <Output />
    </>
  );
}

function MachineRow({
  name,
  m,
}: {
  name: string;
  m: Machine;
}) {
  const search = [name, m.address, m.description].join(" ").toLowerCase();
  const hidden =
    filterText !== "" && !search.includes(filterText.toLowerCase());
  return (
    <tr data-search={search} hidden={hidden}>
      <td className="name-cell">
        <span className="host-avatar" aria-hidden="true">
          {name.slice(0, 2).toUpperCase()}
        </span>
        <span className="name-content">
          {name}
          <p>{m.description}</p>
          <details className="machine-details">
            <summary>Details</summary>
            <dl>
              <dt>Transport</dt>
              <dd>{m.transport === "local" ? "This device" : "SSH"}</dd>
              <dt>SSH account</dt>
              <dd>{m.user ?? "Local"}</dd>
              <dt>Port</dt>
              <dd>{String(m.port ?? 22)}</dd>
              <dt>SSH alias</dt>
              <dd>{String(m.ssh_alias ?? "—")}</dd>
              <dt>Cautions</dt>
              <dd>
                {Array.isArray(m.caution)
                  ? m.caution.join("; ")
                  : "None recorded"}
              </dd>
            </dl>
          </details>
        </span>
      </td>
      <td>
        {m.transport === "local" ? (
          "This device"
        ) : (
          <>
            <code>{m.address}</code>
            <p>{m.user} · SSH</p>
          </>
        )}
      </td>
      <td>
        <span className="badge">{accessLabel(m.access)}</span>
      </td>
      <td>
        <div className="actions">
          <Btn action="doctor" label="Check" id={name} />
          <Btn action="command" label="Command" id={name} />
          {m.transport === "ssh" ? (
            <Btn action="edit" label="Edit" id={name} kind="quiet" />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function MachineForm() {
  const m =
    editing !== undefined ? state.inventory.machines[editing] : undefined;
  const extra = JSON.stringify(
    m
      ? Object.fromEntries(
          Object.entries(m).filter(
            ([k]) =>
              ![
                "address",
                "user",
                "description",
                "access",
                "transport",
                "ssh_alias",
              ].includes(k),
          ),
        )
      : {},
    null,
    2,
  );
  return (
    <section className="panel">
      <h2>{m ? "Edit machine" : "Add SSH host"}</h2>
      <p className="muted">
        Create a key in Access with the same name as this machine, install its
        public key on the host, and verify the host fingerprint. homectl links
        the matching key automatically.
      </p>
      <form id="machine-form" className="form-grid" key={editing}>
        <div>
          <label htmlFor="machine-name">Name</label>
          <input
            id="machine-name"
            name="name"
            pattern="[a-z][a-z0-9-]{0,62}"
            defaultValue={editing}
            required
            readOnly={m !== undefined}
          />
        </div>
        <div>
          <label htmlFor="machine-address">Address</label>
          <input
            id="machine-address"
            name="address"
            defaultValue={m?.address}
            required
          />
        </div>
        <div>
          <label htmlFor="machine-user">SSH account</label>
          <input
            id="machine-user"
            name="user"
            defaultValue={m?.user}
            required
          />
        </div>
        <div>
          <label htmlFor="machine-access">Access</label>
          <select
            id="machine-access"
            name="access"
            defaultValue={m?.access}
          >
            <option value="observe">Read-only (observe)</option>
            <option value="user">Standard user (user)</option>
            <option value="sudo-approved">
              Approved admin commands (sudo-approved)
            </option>
            <option value="full">Full account (full)</option>
          </select>
        </div>
        <div className="full">
          <label htmlFor="machine-description">Description</label>
          <input
            id="machine-description"
            name="description"
            defaultValue={m?.description}
            required
          />
        </div>
        <details className="full">
          <summary>Advanced SSH settings</summary>
          <p className="inline-note">
            Optional JSON fields for a non-default port, cautions, sudo rules,
            or a custom key reference.
          </p>
          <label htmlFor="machine-json">Additional fields (JSON)</label>
          <textarea id="machine-json" name="extra" defaultValue={extra} />
        </details>
        <div className="full form-actions">
          {m ? (
            <Btn
              action="machine-delete"
              label="Remove machine"
              id={editing}
              kind="quiet danger"
            />
          ) : null}
          <Btn action="cancel-edit" label="Cancel" />
          <button className="primary" type="submit">
            Save machine
          </button>
        </div>
      </form>
    </section>
  );
}

function Machines() {
  const hosts = Object.entries(state.inventory.machines);
  return (
    <>
      <Heading
        title="Machines"
        description="Your SSH hosts and this device. Every operation has an explicit target."
        actions={<Btn action="add" label="Add machine" kind="primary" />}
      />
      {state.operations?.length ? (
        <section className="panel section">
          <h2>Operations awaiting your approval</h2>
          {state.operations.map((o) => (
            <div className="peer-row" key={o.id}>
              <div>
                <strong>
                  {o.peerName} → {o.host}
                </strong>
                <pre>{displayArgv(o.argv)}</pre>
                <p>{o.impact ?? "Review the exact target and impact"}</p>
              </div>
              <div className="actions">
                <Btn
                  action="operation-approve"
                  label="Approve"
                  id={o.id}
                  kind="primary"
                />
                <Btn action="operation-reject" label="Reject" id={o.id} />
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {editing !== undefined ? (
        <MachineForm />
      ) : (
        <>
          <div className="filters">
            <label className="muted" htmlFor="filter">
              Find a machine
            </label>
            <input
              id="filter"
              type="search"
              placeholder="Name, address, or description"
              autoComplete="off"
              value={filterText}
              onChange={(e) => {
                filterText = e.target.value;
                render();
              }}
            />
          </div>
          {!hosts.length ? (
            <div className="empty">
              <h2>Choose how to get started</h2>
              <p>Add an SSH machine, or bring in a setup from another computer.</p>
              <div className="actions">
                <Btn action="add" label="Add an SSH machine" kind="primary" />
                <Btn
                  action="navigate-peers"
                  label="Use another computer’s setup"
                />
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Machine</th>
                    <th>Connection</th>
                    <th>Access</th>
                    <th>
                      <span className="muted">Operations</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hosts.map(([name, m]) => (
                    <MachineRow key={name} name={name} m={m} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Output />
        </>
      )}
    </>
  );
}

function PairingPanel({ p }: { p: NonNullable<State["pair"]> }) {
  return (
    <section className="panel">
      <h2>{p.sas ? "Verify this device" : "Pairing window open"}</h2>
      <p className="muted">
        Code expires at {formatLocalDate(p.expiresAt)}.
      </p>
      {p.code ? (
        <>
          <p>
            On the other computer, open{" "}
            <strong>Devices → Join a pairing session</strong>. Use this address
            and one-time code:
          </p>
          <p className="pair-code">{pairingAddress()}</p>
          <p className="pair-code">{p.code}</p>
          <p>Or run this command on the other computer:</p>
          <pre>{`homectl pair --address ${pairingAddress()}`}</pre>
          <div className="actions">
            <Btn action="pair-copy-command" label="Copy command" />
            <Btn action="pair-copy-code" label="Copy one-time code" />
          </div>
          <p className="inline-note">
            The command asks for the code privately so it is not saved in
            terminal history.
          </p>
          <p className="inline-note">
            Use the computer&apos;s reachable LAN address. If it runs in Docker,
            use the Docker host address, not a container-only IP. Keep the code
            on your devices; do not put it in chat or logs.
          </p>
          <p>
            When both computers show the same verification phrase, confirm it on
            each one.
          </p>
        </>
      ) : null}
      {p.sas ? (
        <>
          <p>
            Compare this phrase on both computers. Device:{" "}
            <strong>{p.remote?.name}</strong>.
          </p>
          <div className="verification">{p.sas}</div>
          <p>
            {p.localConfirmed
              ? "You confirmed this phrase."
              : "Confirm only if both computers show the same phrase."}{" "}
            {p.remoteConfirmed
              ? "The other computer confirmed too."
              : "Waiting for the other computer to confirm."}
          </p>
          {!p.localConfirmed ? (
            <Btn action="pair-confirm" label="The phrases match" kind="primary" />
          ) : null}
        </>
      ) : null}
      <div className="form-actions">
        <Btn action="pair-cancel" label="Cancel pairing" />
      </div>
    </section>
  );
}

function Peers() {
  const p = state.pair;
  return (
    <>
      <Heading
        title="Devices"
        description="Connect this computer to another homectl workspace. No separate server command is needed."
        actions={p ? undefined : <Btn action="pair-open" label="Start pairing" kind="primary" />}
      />
      {p ? <PairingPanel p={p} /> : null}
      <section className="section split" hidden={p !== undefined}>
        <div className="panel">
          <h2>Devices on your LAN</h2>
          {state.discovery.devices.length ? (
            state.discovery.devices.map((d) => (
              <div className="peer-row" key={d.id}>
                <div>
                  <strong>Ready to pair</strong>
                  <p>{d.address}</p>
                </div>
                <Btn action="discovered" label="Use this device" id={d.address} />
              </div>
            ))
          ) : (
            <>
              <p className="muted">
                No device found automatically. That’s okay: enter its address
                and code below.
              </p>
              <details>
                <summary>Why automatic discovery may not work</summary>
                <p>
                  Docker, Wi-Fi isolation, VLANs, and firewalls can block LAN
                  discovery. Direct connection still works. For troubleshooting,
                  allow UDP 5353 for discovery and TCP 7448 for pairing on the
                  private LAN; no router port forwarding is needed.
                </p>
                {state.discovery.error ? (
                  <p className="inline-note">{state.discovery.error}</p>
                ) : null}
              </details>
            </>
          )}
        </div>
        <div className="panel">
          <h2>Join a pairing session</h2>
          <p className="muted">
            On the other computer, choose Start pairing. Enter its LAN address
            and one-time code here, then compare the phrase on both devices.
          </p>
          <form id="pair-form" className="stack">
            <div>
              <label htmlFor="peer-address">
                Other computer’s address (port 7448)
              </label>
              <input
                id="peer-address"
                name="address"
                placeholder="http://192.168.1.142:7448"
                required
              />
            </div>
            <div>
              <label htmlFor="pair-code">One-time code</label>
              <input
                id="pair-code"
                name="code"
                inputMode="numeric"
                placeholder="1234-5678"
                autoComplete="off"
                required
              />
            </div>
            <button className="primary">Connect</button>
          </form>
        </div>
      </section>
      <section className="section">
        <h2>Paired devices</h2>
        {control?.devices ? (
          <p className="inline-note">
            This device signs control records with{" "}
            <code>{control.devices.self.fingerprint ?? "no key yet"}</code>.
          </p>
        ) : null}
        {state.peers.length ? (
          <div className="panel peer-list">
            {state.peers.map((peer) => (
              <div className="peer-row" key={peer.id}>
                <div>
                  <strong>{peer.name}</strong>{" "}
                  <span className="badge">{peer.platform}</span>
                  <p>{peer.address}</p>
                  <SigningNote id={peer.id} />
                  <p>
                    {peer.permissions.sync ? "Sync enabled" : "Sync disabled"} ·{" "}
                    {peer.permissions.diagnostics
                      ? "Diagnostics enabled"
                      : "Diagnostics disabled"}{" "}
                    · {peer.permissions.operations.length} operation grants
                  </p>
                </div>
                <div className="actions">
                  <Btn action="sync-start" label="Compare and sync" id={peer.id} />
                  <Btn action="peer-status" label="Status" id={peer.id} />
                  <Btn
                    action="peer-permissions"
                    label="Permissions"
                    id={peer.id}
                    kind="quiet"
                  />
                  <Btn
                    action="peer-forget"
                    label="Remove trust"
                    id={peer.id}
                    kind="quiet danger"
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <h2>No paired devices yet</h2>
            <p>
              Start pairing here and enter the code on the other computer. Check
              that both show the same phrase before confirming.
            </p>
          </div>
        )}
      </section>
      <Output />
    </>
  );
}

// Output of the last remote or local operation, shown under the current view.
function Output() {
  return (
    <>
      {operationResult ? (
        <section className="section panel">
          <h2>Waiting for peer approval</h2>
          <p className="muted">
            Open the execution device’s workspace, review the command, and approve
            it locally.
          </p>
          <Btn action="operation-status" label="Check result" />
        </section>
      ) : null}
      {remoteHosts ? (
        <section className="section panel">
          <h2>Hosts on the paired device</h2>
          {remoteHosts.hosts.map((h) => (
            <div className="peer-row" key={h.name}>
              <div>
                <strong>{h.name}</strong>
                <p>
                  {h.description} · {h.access}
                </p>
              </div>
              <Btn action="remote-command" label="Command" id={h.name} />
            </div>
          ))}
        </section>
      ) : null}
      {result !== undefined ? (
        <section className="section panel">
          <h2>Operation result</h2>
          <pre>
            {typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)}
          </pre>
        </section>
      ) : null}
    </>
  );
}

// ---- Sync ----
function syncChangeCards(
  entries: NonNullable<Preview["entries"]>,
  versionOnly = false,
) {
  return entries.map(({ id, local, remote }) => {
    const [type, ...parts] = id.split(":");
    const name = parts.join(":");
    const label =
      (
        {
          machine: "Machine",
          credential: "Credential",
          hostkey: "Trusted host key",
          provider: "Provider",
        } as Record<string, string>
      )[type ?? ""] ?? "Entry";
    const before = local?.value ?? null;
    const after = remote.value;
    const action = versionOnly
      ? after === null
        ? "Deleted"
        : "Current version"
      : after === null
        ? "Remove"
        : before === null
          ? "Add"
          : "Update";
    const fields =
      type === "machine"
        ? ["description", "address", "user", "access", "transport"]
        : type === "provider"
          ? ["type", "host", "node"]
          : [];
    const object = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const left = object(before);
    const right = object(after);
    const display = (value: unknown) =>
      value === undefined || value === null || value === ""
        ? "—"
        : String(value);
    const details = fields.filter(
      (key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]),
    );
    const note =
      type === "credential"
        ? "Secret contents stay hidden."
        : type === "hostkey"
          ? "Review the host fingerprint independently before trusting it."
          : "";
    return (
      <article className="sync-change" key={id}>
        <h3>
          {label}: {name}
        </h3>
        <span className="badge">{action}</span>
        {details.length ? (
          <dl className="sync-change-fields">
            {details.map((key) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  {before !== null
                    ? `${display(left[key])} → `
                    : ""}
                  {display(right[key])}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {note ? <p className="inline-note">{note}</p> : null}
      </article>
    );
  });
}

function SyncWait() {
  if (!syncWaitVisible()) return null;
  const name =
    preview?.remoteName ||
    state.peers.find((p) => p.id === syncWaiting?.peerId)?.name ||
    "the other device";
  return (
    <section className="sync-wait" aria-labelledby="sync-wait-title">
      <h3 id="sync-wait-title">Unlock the vault on {name}</h3>
      <p>
        On {name}, open homectl → Access → Unlock vault, or run this command in
        a private terminal:
      </p>
      <div className="actions">
        <code>homectl session unlock</code>
        <Btn action="sync-copy-unlock" label="Copy command" />
      </div>
      <p id="sync-wait-status" role="status">
        {syncWaitStatus}
      </p>
    </section>
  );
}

function RetainedVersion({
  p,
  index,
  conflict,
}: {
  p: Preview;
  index: number;
  conflict: Preview["conflicts"][number];
}) {
  const choice = conflictChoice[index];
  if (choice === undefined) return null;
  const selected = choice === "remote" ? conflict.remote : conflict.local;
  const versions =
    choice === "both" ? [conflict.local, conflict.remote] : [selected];
  return (
    <div className="retained version" role="status">
      <h3>{choice === "both" ? "Both versions kept" : "Selected version"}</h3>
      <p className="muted">
        {choice === "both"
          ? "The received version will be copied to a new entry."
          : choice === "remote"
            ? p.remoteName
            : p.localName}
      </p>
      {versions.map((remote, i) => (
        <div key={i}>
          {syncChangeCards([{ id: conflict.id, local: null, remote }], true)}
        </div>
      ))}
      <Btn action="compare-conflict" label="Compare again" id={String(index)} kind="quiet" />
    </div>
  );
}

function ConflictCard({
  p,
  index,
  conflict,
}: {
  p: Preview;
  index: number;
  conflict: Preview["conflicts"][number];
}) {
  const choice = conflictChoice[index];
  const options: [string, string][] = [
    ["local", `Use from ${p.localName}`],
    ["remote", `Use from ${p.remoteName}`],
    ...(conflict.id.startsWith("hostkey:")
      ? []
      : ([["both", "Keep both as separate entries"]] as [string, string][])),
  ];
  return (
    <section
      className={choice !== undefined ? "conflict resolved" : "conflict"}
      data-conflict={index}
    >
      <h3>{conflict.id}</h3>
      <div className="split" hidden={choice !== undefined}>
        <div className="version">
          <h3>
            {p.localName} <span className="badge">Local</span>
          </h3>
          {syncChangeCards([{ id: conflict.id, local: null, remote: conflict.local }], true)}
        </div>
        <div className="version">
          <h3>
            {p.remoteName} <span className="badge">Received</span>
          </h3>
          {syncChangeCards([{ id: conflict.id, local: null, remote: conflict.remote }], true)}
        </div>
      </div>
      <RetainedVersion p={p} index={index} conflict={conflict} />
      <div className="choice">
        {options.map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name={`choice-${index}`}
              value={value}
              required
            />
            {label}
          </label>
        ))}
      </div>
    </section>
  );
}

function SyncPreview({ p }: { p: Preview }) {
  return (
    <section className="panel">
      <h2>
        {p.localName} ↔ {p.remoteName}
      </h2>
      <p className="muted">
        {p.changes.length} changed entries · {p.conflicts.length} conflicts.
        Secrets stay hidden.
      </p>
      <SyncWait />
      <form id="sync-form" key={p.id}>
        {p.conflicts.map((c, i) => (
          <ConflictCard key={c.id + i} p={p} index={i} conflict={c} />
        ))}
        <details>
          <summary>Changes to review</summary>
          <div className="sync-change-list">
            {p.entries
              ? syncChangeCards(p.entries)
              : p.changes.map((id) => (
                  <article className="sync-change" key={id}>
                    <h3>{id}</h3>
                  </article>
                ))}
          </div>
        </details>
        <div className="form-actions">
          <Btn action="sync-cancel" label="Cancel" />
          {syncPeerId ? (
            <Btn action="sync-restart" label="Compare devices again" />
          ) : null}
          <button className="primary" disabled={syncWaitVisible()}>
            Apply selected changes
          </button>
        </div>
      </form>
    </section>
  );
}

function SyncView() {
  return (
    <>
      <Heading
        title="Sync"
        description="Changes flow both ways. Review the scope and resolve conflicts before applying."
      />
      {preview ? (
        <SyncPreview p={preview} />
      ) : state.pending.length ? (
        <section className="panel">
          <h2>Awaiting your review</h2>
          {state.pending.map((p) => (
            <div className="peer-row" key={p.id}>
              <div>
                <strong>{p.remoteName}</strong>
                <p>
                  A peer is proposing changes. Open the comparison before
                  applying them.
                </p>
              </div>
              <Btn action="sync-preview" label="Review" id={p.id} />
            </div>
          ))}
        </section>
      ) : (
        <div className="empty">
          <h2>You decide what changes</h2>
          <p>
            Choose a paired device to compare entries. Unlock both vaults to sync
            SSH credentials.
          </p>
          <Btn action="navigate-peers" label="Choose a device" kind="primary" />
        </div>
      )}
      <ControlSyncSection />
      <Output />
    </>
  );
}

// ---- Control sync ----
function ControlSyncSection() {
  if (!control)
    return (
      <section className="panel section">
        <h2>Control sync</h2>
        <p className="muted">
          Control status is unavailable right now. Refresh to try again.
        </p>
      </section>
    );
  const sync = control.sync;
  if (sync?.disabledBy)
    return (
      <section className="panel section">
        <h2>Control sync</h2>
        <p className="muted">
          Control sync is disabled by {sync.disabledBy} on this device.
          Operations that have paired peers wait for a sync.
        </p>
      </section>
    );
  if (!sync?.running)
    return (
      <section className="panel section">
        <h2>Control sync</h2>
        <p className="muted">
          Control sync runs while this homectl workspace is open.
        </p>
      </section>
    );
  const now = Date.now();
  const names = sync.names ?? {};
  return (
    <section className="panel section">
      <h2>Control sync</h2>
      <p className="muted">
        Approvals and executions travel on this sync. It updates every 15
        seconds while this workspace is open.
      </p>
      {sync.peers.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Last sync</th>
                <th>Lease</th>
                <th>Backoff</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sync.peers.map((p) => (
                <SyncRow key={p.id} p={p} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No paired devices take part in control sync yet.</p>
      )}
      {sync.conflicts.length ? (
        <>
          <h3 className="section">Control conflicts</h3>
          <p className="inline-note">
            Two different handoffs were recorded for the same operation. Nobody
            can run it until the conflict is resolved. Choose the owner here;
            that device must accept on its own side before the resolution
            applies.
          </p>
          {sync.conflicts.map((c) => (
            <ConflictRow
              key={c.opId}
              c={c}
              names={names}
              resolutions={sync.resolutions ?? []}
            />
          ))}
        </>
      ) : (
        <p className="inline-note">No control conflicts.</p>
      )}
      {Object.entries(sync.blocked).map(([origin, reason]) => (
        <p className="inline-note" key={origin}>
          Log from {names[origin] ?? origin} is blocked: {reason}
        </p>
      ))}
    </section>
  );
}

// One paired device. A suspended device is out of this device's lease until it
// syncs again or is resumed; a legacy device has no control sync at all.
function SyncRow({
  p,
  now,
}: {
  p: ControlSync["peers"][number];
  now: number;
}) {
  const name = (
    <td data-label="Device">
      <strong>{p.name}</strong>
    </td>
  );
  const lastSync =
    p.lastSync === undefined ? (
      <span className="muted">never</span>
    ) : (
      relative(new Date(p.lastSync).toISOString())
    );
  if (p.suspended)
    return (
      <tr>
        {name}
        <td data-label="Last sync">{lastSync}</td>
        <td data-label="Lease">
          <span className="warn-text">
            suspended by {p.suspended.by} at {localStamp(p.suspended.at)}
          </span>
        </td>
        <td data-label="Backoff">
          <span className="muted">—</span>
        </td>
        <td data-label="Status">
          <span className="muted">not counted in the lease</span>
        </td>
        <td data-label="Action" className="cell-action">
          <Btn action="control-peer-resume" label="Resume" id={p.id} kind="quiet" />
        </td>
      </tr>
    );
  if (p.excluded)
    return (
      <tr>
        {name}
        <td data-label="Last sync">
          <span className="muted">never (control)</span>
        </td>
        <td data-label="Lease">
          <span className="muted">excluded from lease: re-pair required</span>
        </td>
        <td data-label="Backoff">
          <span className="muted">—</span>
        </td>
        <td data-label="Status">
          <span className="badge warning" title={p.refused ?? ""}>
            re-pair required
          </span>
        </td>
        <td data-label="Action">
          <span className="muted">—</span>
        </td>
      </tr>
    );
  const retry =
    p.nextAttemptAt !== undefined &&
    (p.failures ?? 0) > 0 &&
    p.nextAttemptAt > now
      ? `retry ${localStamp(new Date(p.nextAttemptAt).toISOString())}`
      : "none";
  return (
    <tr>
      {name}
      <td data-label="Last sync">{lastSync}</td>
      <td data-label="Lease">
        {p.leaseOk ? (
          "ok"
        ) : (
          <span className="danger">expired: waiting for sync</span>
        )}
      </td>
      <td data-label="Backoff">{retry}</td>
      <td data-label="Status">
        {p.lastError ? (
          <span className="danger">{p.lastError}</span>
        ) : (
          <span className="badge success">ok</span>
        )}
      </td>
      <td data-label="Action" className="cell-action">
        <Btn
          action="control-peer-suspend"
          label="Suspend from lease"
          id={p.id}
          kind="quiet danger"
        />
      </td>
    </tr>
  );
}

// One conflicting operation: its candidates, any proposal waiting, and the
// owner choice (any device involved can propose; the chosen one must accept).
function ConflictRow({
  c,
  names,
  resolutions,
}: {
  c: { opId: string; epoch: number; candidates: string[] };
  names: Record<string, string>;
  resolutions: NonNullable<ControlSync["resolutions"]>;
}) {
  const mine = resolutions.filter((r) => r.opId === c.opId);
  const accept = mine.some((r) => r.waitingForSelf);
  return (
    <div className="peer-row conflict-row">
      <div className="conflict-text">
        <strong>
          <code>{c.opId.slice(0, 8)}</code>
        </strong>{" "}
        at epoch {c.epoch}: {c.candidates.map((id) => names[id] ?? id).join(", ")}
        {mine.map((r, i) => (
          <p className="inline-note" key={i}>
            Proposed by {names[r.resolver] ?? r.resolver}: owner{" "}
            {names[r.winner] ?? r.winner}.
          </p>
        ))}
      </div>
      <div className="conflict-controls">
        {accept ? (
          <Btn
            action="control-resolve-accept"
            label="Accept resolution"
            id={c.opId}
            kind="primary"
          />
        ) : null}
        <label className="sr-only" htmlFor={`resolve-${c.opId}`}>
          Owner for {c.opId.slice(0, 8)}
        </label>
        <select id={`resolve-${c.opId}`} data-conflict-select={c.opId}>
          {c.candidates.map((id) => (
            <option key={id} value={id}>
              {names[id] ?? id}
            </option>
          ))}
        </select>
        <Btn action="control-resolve" label="Resolve…" id={c.opId} kind="quiet" />
      </div>
    </div>
  );
}

// ---- Access and settings ----
function Access() {
  const createVault = !state.vaultExists;
  return (
    <>
      <Heading
        title="Access"
        description="Vaults and sessions are local. Pairing does not unlock the other computer."
      />
      <div className="split">
        <section className="panel">
          <h2>Encrypted vault</h2>
          {state.vaultUnlocked ? (
            <div className="empty">
              <h3>Vault unlocked</h3>
              <p>
                Credential sync is ready on this device. SSH access is managed
                separately.
              </p>
            </div>
          ) : (
            <>
              <p className="muted">
                {createVault
                  ? "Create an encrypted vault on this device."
                  : "Unlock this device’s encrypted vault to sync credentials."}
              </p>
              <form
                id="unlock-form"
                className="stack"
                key={createVault ? "create" : "unlock"}
              >
                <div>
                  <label htmlFor="password">
                    {createVault ? "Choose a vault password" : "Vault password"}
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete={createVault ? "new-password" : "current-password"}
                    required
                  />
                </div>
                {createVault ? (
                  <>
                    <div>
                      <label htmlFor="password-confirm">
                        Confirm vault password
                      </label>
                      <input
                        id="password-confirm"
                        name="password-confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                      />
                    </div>
                    <input type="hidden" name="create" value="true" />
                  </>
                ) : null}
                <button className="primary">
                  {createVault ? "Create and unlock vault" : "Unlock vault"}
                </button>
              </form>
              <p className="inline-note">
                The password stays on this device. It is never sent to peers or
                saved in logs.
              </p>
            </>
          )}
        </section>
        <section className="panel">
          <h2>SSH session</h2>
          <dl>
            <dt>Status</dt>
            <dd>{state.session.unlocked ? "Unlocked" : "Locked"}</dd>
            <dt>Expires</dt>
            <dd>
              {state.session.unlocked
                ? state.session.expiresAt
                  ? formatLocalDate(state.session.expiresAt)
                  : "On lock or restart"
                : "—"}
            </dd>
            <dt>Session lifetime</dt>
            <dd>{sessionTtlLabel(state.inventory.session?.ttl ?? "24h")}</dd>
          </dl>
          <div className="form-actions">
            <Btn action="lock" label="Lock access" kind="quiet" />
          </div>
          <p className="inline-note">
            Locking stops new SSH connections from using these keys. Already-connected
            sessions may continue.
          </p>
        </section>
      </div>
      <section className="section panel">
        <h2>Create an SSH key</h2>
        <p className="muted">
          Create a key for the machine you plan to add, then install its public
          key there.
        </p>
        <form id="key-form" className="form-grid">
          <div>
            <label htmlFor="key-name">Key and machine name</label>
            <input
              id="key-name"
              name="name"
              pattern="[a-z][a-z0-9-]{0,62}"
              placeholder="storage-nas"
              required
            />
          </div>
          <div>
            <label htmlFor="key-password">Vault password</label>
            <input
              id="key-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div className="full form-actions">
            <button className="primary">Create SSH key</button>
          </div>
        </form>
        <p className="inline-note">
          You’ll get the public key to install on the machine. Creating a key locks
          SSH access; unlock again afterwards.
        </p>
      </section>
      <Output />
    </>
  );
}

// The session lifetime control: presets, or a custom duration in a disclosure.
function SessionTtlControl({ value }: { value: string }) {
  const isPreset = sessionTtlPresets.some(([ttl]) => ttl === value);
  const [custom, setCustom] = useState(!isPreset);
  const selected = custom ? "custom" : value;
  return (
    <div>
      <label htmlFor="ttl">Session lifetime</label>
      <select
        id="ttl"
        name="ttl"
        defaultValue={selected}
        onChange={(e) => setCustom(e.target.value === "custom")}
      >
        {sessionTtlPresets.map(([ttl, label]) => (
          <option key={ttl} value={ttl}>
            {label}
          </option>
        ))}
        <option value="custom">Custom duration…</option>
      </select>
      <details id="custom-ttl" open={custom}>
        <summary>Set a custom duration</summary>
        <label htmlFor="custom-ttl-value">Duration</label>
        <input
          id="custom-ttl-value"
          name="custom-ttl"
          defaultValue={isPreset ? "" : value}
          placeholder="For example, 30m or 2d"
          pattern="[1-9][0-9]{0,6}[smhd]"
          autoComplete="off"
        />
        <p className="inline-note">
          Use seconds, minutes, hours, or days (up to 365 days).
        </p>
      </details>
    </div>
  );
}

function Settings() {
  return (
    <>
      <Heading
        title="Settings"
        description="This device’s identity, session lifetime, and background execution."
      />
      <div className="split">
        <section className="panel">
          <h2>This device</h2>
          <form id="settings-form" className="stack" key="settings">
            <div>
              <label htmlFor="device-label">Device name</label>
              <input
                id="device-label"
                name="name"
                defaultValue={state.device.name}
                maxLength={100}
                required
              />
            </div>
            <SessionTtlControl value={state.inventory.session?.ttl ?? "24h"} />
            <p className="inline-note">
              Changing the session lifetime locks the current SSH session.
            </p>
            <button className="primary">Save settings</button>
          </form>
        </section>
        <section className="panel">
          <h2>Server and service</h2>
          <dl>
            <dt>Other devices connect at</dt>
            <dd>
              <code>{pairingAddress()}</code>
            </dd>
            <dt>Panel open in this browser</dt>
            <dd>
              <code>{location.origin}</code>
            </dd>
            <dt>Identity</dt>
            <dd>
              <code>{state.device.id}</code>
            </dd>
          </dl>
          <h3 className="section">Keep homectl running in the background</h3>
          <p className="muted">
            For a workspace that stays available after closing the panel, install
            and start the service from a terminal. It starts with SSH access locked.
          </p>
          <pre>
            {[
              "homectl service install --interface <LAN-IP>",
              "homectl service start",
              "homectl service status",
            ].join("\n")}
          </pre>
          <p className="inline-note">
            On Windows, install the service once from an administrator terminal. WSL
            requires systemd. See docs/windows.md.
          </p>
        </section>
      </div>
    </>
  );
}

// ---- Approvals (control plane queue) ----
function StateBadge({ label }: { label: string }) {
  const kind =
    label === "ready"
      ? "ready"
      : label === "needs approval"
        ? "warning"
        : label === "succeeded"
          ? "success"
          : label === "failed" || label === "unknown" || label === "expired"
            ? "danger"
            : label === "executing"
              ? "info"
              : "";
  return <span className={`badge ${kind}`}>{label}</span>;
}

function ClassBadge({ op }: { op: ControlOp }) {
  const kind =
    op.classification === "destructive"
      ? "danger"
      : op.classification === "inspect"
        ? ""
        : "warning";
  return <span className={`badge ${kind}`}>{op.classification}</span>;
}

function PrimaryAction({ op }: { op: ControlOp }) {
  // Inspection is the primary action; changes get a distinct warning outline.
  if (isReady(op))
    return (
      <Btn
        action="control-execute"
        label="Execute"
        id={op.operationId}
        kind={op.classification === "inspect" ? "primary" : "change"}
      />
    );
  if (op.state === "pending")
    return (
      <span className="muted">Waiting for approval by another client</span>
    );
  if (op.state === "executing") return <span className="muted">Running…</span>;
  if (op.state === "succeeded")
    return <span className="muted">Exit {op.exitCode ?? 0}</span>;
  return (
    <span className="muted">
      {op.reason ?? "Closed"}
      {op.exitCode !== undefined ? ` · exit ${op.exitCode}` : ""}
    </span>
  );
}

function OpAction({ op }: { op: ControlOp }) {
  // An operation that another device owns runs there; it is never executed here.
  if (op.runsOn) {
    const expired =
      op.offerExpires !== undefined && Date.parse(op.offerExpires) <= Date.now();
    const accept =
      op.offerFrom && !expired ? (
        <Btn
          action="control-handoff-accept"
          label="Accept handoff"
          id={op.operationId}
          kind="primary"
        />
      ) : null;
    const offer = op.offerFrom ? (
      <div className="sub muted">
        Offered by {op.runsOn}; {offerExpiry(op)}
      </div>
    ) : null;
    const takeover = op.takeover?.possible ? (
      <Btn
        action="control-takeover"
        label="Take over here"
        id={op.operationId}
        kind="quiet"
      />
    ) : op.takeover ? (
      <span className="muted">{takeoverText(op)}</span>
    ) : null;
    return (
      <>
        <span className="muted">Runs on {op.runsOn}</span>
        {offer}
        {accept || takeover ? (
          <div className="sub">
            {accept}
            {takeover}
          </div>
        ) : null}
      </>
    );
  }
  if (op.conflict) return <span className="muted">{takeoverText(op)}</span>;
  // An open offer stops execution here until the receiver accepts, it is cancelled, or it expires.
  if (op.offerTo)
    return (
      <>
        <span className="muted">Offered to {op.offerTo}; not runnable here</span>
        <div className="sub muted">{offerExpiry(op)}</div>
        <div className="sub">
          <Btn
            action="control-handoff-cancel"
            label="Cancel offer"
            id={op.operationId}
            kind="quiet danger"
          />
        </div>
      </>
    );
  const handoff =
    op.remote || bucketOf(op) === "history" ? null : (
      <div className="sub">
        <Btn
          action="control-handoff-open"
          label="Hand off…"
          id={op.operationId}
          kind="quiet"
        />
      </div>
    );
  return (
    <>
      <PrimaryAction op={op} />
      {handoff}
    </>
  );
}

// Six columns at 1280px: class sits under the state, impact and fingerprint
// under the command, and the requested cell is two lines at most.
function OpRow({ op }: { op: ControlOp }) {
  const label = displayStateOf(op);
  const open = op.state === "pending" || op.state === "approved";
  const expiresAt =
    op.state === "approved" && op.approval ? op.approval.expiresAt : op.expiresAt;
  // Remote operations have no local expiry; they show when they last changed.
  const when =
    open && !op.remote ? relative(expiresAt, true) : relative(op.updatedAt);
  const approver = op.approval ? (
    op.approval.approver
  ) : op.approvedBy ? (
    op.approvedBy
  ) : op.delivery?.status === "awaiting-confirmation" ? (
    <span className="muted">forwarded, awaiting confirmation</span>
  ) : op.needsApproval ? (
    <span className="muted">awaiting approval</span>
  ) : (
    <span className="muted">not needed</span>
  );
  const actionLabel = bucketOf(op) === "history" ? "Result" : "Action";
  return (
    <tr>
      <td data-label="State">
        <div>
          <StateBadge label={label} />
        </div>
        <div className="cls">
          <ClassBadge op={op} />
        </div>
      </td>
      <td data-label="Host" className="nowrap">
        <strong>{op.host}</strong>
        {op.ownerName ? <span className="sub">owner {op.ownerName}</span> : null}
      </td>
      <td data-label="Command" className="cell-command">
        <code className="cmd">{shellArgv(op.argv)}</code>
        <p className="impact">{op.impact || "—"}</p>
        <span className="fp" title={op.fingerprint}>
          fingerprint {shortHash(op.fingerprint)}
        </span>
      </td>
      <td data-label="Requested → approved" className="cell-people">
        <span className="person">{op.issuer}</span>
        <span className="sub">→ {approver}</span>
      </td>
      <td data-label="When">
        <time dateTime={op.updatedAt} title={localStamp(op.updatedAt)}>
          {when}
        </time>
      </td>
      <td data-label={actionLabel} className="cell-action">
        <OpAction op={op} />
      </td>
    </tr>
  );
}

function OpTable({ ops }: { ops: ControlOp[] }) {
  return (
    <div className="table-wrap">
      <table className="ops">
        <thead>
          <tr>
            <th>State</th>
            <th>Host</th>
            <th>Command</th>
            <th>Requested → approved</th>
            <th>When</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((op) => (
            <OpRow key={op.operationId} op={op} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditCard({ audit }: { audit: ControlAudit | undefined }) {
  const ok = audit?.ok === true;
  // The head hash stays on one line on narrow screens.
  const detail = !audit ? (
    "Audit status is unavailable."
  ) : ok ? (
    <>
      {`${audit.entries} entries · `}
      <span className="nowrap">{`head ${audit.head.slice(0, 4)}…${audit.head.slice(-4)}`}</span>
      {audit.checkedAt ? (
        <>
          {" · checked "}
          <span className="nowrap">{localStamp(audit.checkedAt)}</span>
        </>
      ) : null}
    </>
  ) : (
    `${audit.error ?? "Check failed"}. Preserve the files and investigate.`
  );
  return (
    <section className="panel audit-card">
      <div>
        <h2>Audit</h2>
        <p>
          <span className={`badge ${ok ? "success" : "danger"}`}>
            {ok ? "Verified" : "Attention"}
          </span>{" "}
          <span className="muted">{detail}</span>
        </p>
      </div>
      <Btn action="control-verify" label="Verify now" />
    </section>
  );
}

function QueueSection({ ops }: { ops: ControlOp[] }) {
  if (!ops.length)
    return (
      <div className="empty">
        <h2>No operations yet</h2>
        <p>
          Plans appear here when an MCP client proposes a command with
          homectl_plan. Inspection plans are ready to run at once; changes wait
          for another client to approve.
        </p>
      </div>
    );
  const buckets: Record<ControlBucket, ControlOp[]> = {
    ready: [],
    needs: [],
    history: [],
  };
  for (const op of ops) buckets[bucketOf(op)].push(op);
  for (const list of Object.values(buckets))
    list.sort(
      (a, b) =>
        rankOf(a) - rankOf(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const tabs: [ControlBucket, string][] = [
    ["ready", "Ready to run"],
    ["needs", "Needs approval"],
    ["history", "History"],
  ];
  const note = {
    ready:
      "Inspection plans and approved changes run from here. Operations marked Runs on belong to another device and run there. Every run is audited and single-use.",
    needs:
      "Approval comes from another authorized client's own MCP session. This panel never approves on its behalf.",
    history: "",
  }[controlFilter];
  const empty = {
    ready:
      "Nothing is ready to run. Approved changes and inspection plans appear here.",
    needs:
      "Nothing is waiting for approval. New changes from MCP clients appear here.",
    history: "No finished operations yet.",
  }[controlFilter];
  const visible = buckets[controlFilter];
  return (
    <>
      <div className="filter-tabs" role="group" aria-label="Filter operations">
        {tabs.map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={controlFilter === id ? "primary" : "quiet"}
            aria-pressed={controlFilter === id}
            data-action="control-filter"
            data-id={id}
          >
            {label} <span>{buckets[id].length}</span>
          </button>
        ))}
      </div>
      {note ? <p className="inline-note">{note}</p> : null}
      {visible.length ? (
        <OpTable ops={visible} />
      ) : (
        <div className="empty">
          <p>{empty}</p>
        </div>
      )}
    </>
  );
}

function ClientsSection({ clients }: { clients: ControlClient[] }) {
  const intro = (
    <>
      <p className="muted">
        Clients are added in a private terminal, so the token file is written
        locally and never shown here. Copy this command and replace the
        placeholders:
      </p>
      <pre>
        {'homectl control client add codex-pc --name "Codex PC" --scopes status:read,inspect:read,plan:create --hosts <host> --token-file <path>'}
      </pre>
    </>
  );
  if (!clients.length)
    return (
      <>
        <div className="empty">
          <h2>No clients yet</h2>
          <p>
            Each MCP client gets its own identity, scopes and host grants. Add the
            first one from a terminal.
          </p>
        </div>
        {intro}
      </>
    );
  return (
    <>
      {intro}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Scopes</th>
              <th>Hosts</th>
              <th>Created</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td data-label="Client">
                  <strong>{c.name}</strong>
                  <p>
                    <code>{c.id}</code>
                  </p>
                  {c.oidc ? (
                    <p>
                      <span
                        className="badge"
                        title={`${c.oidc.claim} hash ${c.oidc.identityHash}`}
                      >
                        {c.hasToken ? "OIDC + token" : "OIDC only"} ·{" "}
                        {c.oidc.issuerHost}
                      </span>
                    </p>
                  ) : null}
                </td>
                <td data-label="Scopes">
                  <div className="chips">
                    {c.scopes.map((s) => (
                      <span className="chip" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                </td>
                <td data-label="Hosts">
                  <div className="chips">
                    {c.hosts.map((h) => (
                      <span className="chip" key={h}>
                        {h}
                      </span>
                    ))}
                  </div>
                </td>
                <td data-label="Created">
                  <time dateTime={c.createdAt} title={localStamp(c.createdAt)}>
                    {localStamp(c.createdAt)}
                  </time>
                </td>
                <td data-label="Status">
                  {c.revoked ? (
                    <span className="badge danger">revoked</span>
                  ) : (
                    <span className="badge success">active</span>
                  )}
                </td>
                <td data-label="Action" className="cell-action">
                  {c.revoked ? null : (
                    <Btn
                      action="control-revoke"
                      label="Revoke"
                      id={c.id}
                      kind="quiet danger"
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ResultBlock({ title, text }: { title: string; text: string }) {
  const body = text.trimEnd();
  if (!body.trim()) return null;
  const lines = body.split("\n").length;
  return (
    <details open={lines <= 20}>
      <summary>
        {title} · {lines} line{lines === 1 ? "" : "s"}
      </summary>
      <pre>{body}</pre>
    </details>
  );
}

function ExecutionResult({ r }: { r: ControlExecution }) {
  const op = r.operation;
  const ok = op.state === "succeeded";
  const headline = ok
    ? `✓ succeeded on ${op.host} (exit ${op.exitCode ?? 0})`
    : op.state === "failed" && op.exitCode !== undefined
      ? `✗ failed (exit ${op.exitCode})`
      : `${displayStateOf(op)}${op.reason ? ` · ${op.reason}` : ""}`;
  const took = durationText(op);
  const out = r.output?.stdout ?? "";
  const err = r.output?.stderr ?? "";
  return (
    <section
      id="control-result"
      className="section panel"
      tabIndex={-1}
      aria-labelledby="control-result-title"
    >
      <div className="result-head">
        <h2 id="control-result-title">Execution result</h2>
        <button
          type="button"
          className="quiet"
          aria-label="Close execution result"
          data-action="control-result-close"
        >
          ×
        </button>
      </div>
      <p>
        <strong>{headline}</strong>
        {took ? <span className="muted"> · took {took}</span> : null}
      </p>
      <p className="muted">
        <code>$ {shellArgv(op.argv)}</code>
      </p>
      {!out.trim() && !err.trim() ? (
        <p className="muted">(no output)</p>
      ) : (
        <>
          <ResultBlock title="stdout" text={out} />
          <ResultBlock title="stderr" text={err} />
        </>
      )}
    </section>
  );
}

// Owner-side picker: choose the receiving device, then confirm the offer.
function HandoffPicker() {
  if (!handoffPicker) return null;
  const op = control?.operations.find((o) => o.operationId === handoffPicker);
  if (!op) return null;
  const devices = (control?.devices?.peers ?? []).filter((p) => !p.legacy);
  if (!devices.length)
    return (
      <section className="panel section">
        <h2>Hand off {op.host}</h2>
        <p className="muted">
          No paired device can take a handoff yet. Pair a device again so it has a
          signing key.
        </p>
        <div className="form-actions">
          <Btn action="control-handoff-close" label="Close" />
        </div>
      </section>
    );
  return (
    <section className="panel section">
      <h2>Hand off {op.host}</h2>
      <p className="muted">
        The receiving device must accept. Until it does, this device keeps the
        operation and will not run it. You can cancel the offer before it is
        accepted.
      </p>
      <div>
        <label htmlFor="handoff-target">Receiving device</label>
        <select id="handoff-target">
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-actions">
        <Btn action="control-handoff-close" label="Close" />
        <Btn
          action="control-handoff-go"
          label="Continue…"
          id={op.operationId}
          kind="primary"
        />
      </div>
    </section>
  );
}

// Read-only OIDC card with the command to change it, ready to copy.
function OidcCard({ oidc }: { oidc: OidcOverview | undefined }) {
  if (!oidc)
    return (
      <section className="panel section">
        <h2>OIDC</h2>
        <p className="muted">
          Not configured. Static client tokens are the only credentials. Configure
          it from a private terminal:
        </p>
        <pre>homectl control oidc set --issuer https://&lt;issuer&gt; --audience &lt;audience&gt;</pre>
      </section>
    );
  const minutes = Math.round(oidc.maxLifetimeSeconds / 60);
  const command = `homectl control oidc set --issuer ${oidc.issuer} --audience ${oidc.audience}${oidc.jwks === "configured" ? " --jwks-url <jwks-url>" : ""} --max-lifetime ${minutes}m`;
  return (
    <section className="panel section">
      <h2>OIDC</h2>
      <p className="muted">Read-only. Change it from a private terminal.</p>
      <dl>
        <dt>Issuer host</dt>
        <dd>{oidc.issuerHost}</dd>
        <dt>Audience</dt>
        <dd>{oidc.audience}</dd>
        <dt>JWKS source</dt>
        <dd>
          {oidc.jwks === "configured"
            ? `configured · ${oidc.jwksHost ?? ""}`
            : "discovery (from the issuer)"}
        </dd>
        <dt>Last JWKS refresh</dt>
        <dd>
          {oidc.refreshedAt
            ? localStamp(oidc.refreshedAt)
            : "not yet (no sign-in since start)"}
        </dd>
        <dt>Keys</dt>
        <dd>{oidc.keyCount}</dd>
        <dt>Last error</dt>
        <dd>{oidc.lastError ? oidc.lastError : "none"}</dd>
        <dt>Max token lifetime</dt>
        <dd>{minutes} min</dd>
        <dt>Mapped clients</dt>
        <dd>{oidc.mappedClients}</dd>
      </dl>
      <p className="inline-note">Change it with:</p>
      <pre>{command}</pre>
    </section>
  );
}

function Approvals() {
  return (
    <>
      <Heading
        title="Approvals"
        description="Plans and runs from MCP clients. Approval comes from another client; this panel runs only what is already approved."
      />
      <AuditCard audit={control?.audit} />
      <div className="filter-tabs" role="tablist" aria-label="Approvals sections">
        <button
          type="button"
          role="tab"
          aria-selected={controlTab === "queue"}
          className={controlTab === "queue" ? "primary" : "quiet"}
          data-action="control-tab"
          data-id="queue"
        >
          Operations
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={controlTab === "clients"}
          className={controlTab === "clients" ? "primary" : "quiet"}
          data-action="control-tab"
          data-id="clients"
        >
          Clients
        </button>
      </div>
      {controlTab === "queue" ? (
        <QueueSection ops={control?.operations ?? []} />
      ) : (
        <>
          <OidcCard oidc={control?.oidc} />
          <ClientsSection clients={control?.clients ?? []} />
        </>
      )}
      <HandoffPicker />
      {controlResult ? <ExecutionResult r={controlResult} /> : null}
    </>
  );
}

function ExecutionDetails({ op }: { op: ControlOp }) {
  return (
    <>
      <p>
        <span
          className={`badge ${op.classification === "destructive" ? "danger" : op.classification === "inspect" ? "" : "warning"}`}
        >
          {op.classification}
        </span>{" "}
        {op.classification === "destructive" ? (
          <strong className="danger">This operation can delete or overwrite data.</strong>
        ) : null}
      </p>
      <dl>
        <dt>Host</dt>
        <dd>{op.host}</dd>
        <dt>Command</dt>
        <dd>
          <code>{shellArgv(op.argv)}</code>
        </dd>
        <dt>Impact</dt>
        <dd>{op.impact || "—"}</dd>
        <dt>Fingerprint</dt>
        <dd>
          <code>{op.fingerprint}</code>
        </dd>
        <dt>Approver</dt>
        <dd>{op.approval?.approver ?? "none needed (inspection)"}</dd>
      </dl>
    </>
  );
}

// ---- Dialogs ----
function ConfirmDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const request = confirmRequest;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (request && !d.open) d.showModal();
    if (!request && d.open) d.close();
  });
  return (
    <dialog
      id="confirm-dialog"
      ref={ref}
      onClose={() => {
        const pending = confirmRequest;
        if (pending) pending.resolve(ref.current?.returnValue === "confirm");
      }}
    >
      <form method="dialog">
        <h2 id="confirm-title">{request?.title}</h2>
        <div id="confirm-description">{request?.body}</div>
        <div className="form-actions">
          <button value="cancel" className="secondary">
            Cancel
          </button>
          <button value="confirm" className="primary">
            Confirm
          </button>
        </div>
      </form>
    </dialog>
  );
}

function UnlockDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const request = unlockRequest;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (request && !d.open) {
      d.showModal();
      passwordRef.current?.focus();
    }
    if (!request && d.open) d.close();
  });
  return (
    <dialog
      id="sync-unlock-dialog"
      ref={ref}
      onClose={() => {
        if (unlockRequest) closeUnlock(false);
      }}
    >
      <form
        id="sync-unlock-form"
        className="stack"
        onSubmit={(event) => void submitUnlock(event)}
      >
        <h2>Unlock this device&apos;s vault</h2>
        <p>
          Enter this device&apos;s vault password. After unlocking, compare the devices
          again to review a fresh sync preview. The password is sent to this
          workspace over the current connection.
        </p>
        <label htmlFor="sync-unlock-password">Vault password</label>
        <input
          id="sync-unlock-password"
          ref={passwordRef}
          type="password"
          autoComplete="current-password"
          required
        />
        <p id="sync-unlock-error" role="alert" hidden={!request?.error}>
          {request?.error}
        </p>
        <div className="form-actions">
          <button
            type="button"
            id="sync-unlock-cancel"
            className="secondary"
            onClick={() => closeUnlock(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={request?.submitting === true}
          >
            Unlock vault
          </button>
        </div>
      </form>
    </dialog>
  );
}

async function submitUnlock(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const password = element<HTMLInputElement>("sync-unlock-password");
  const value = password.value;
  password.value = "";
  if (unlockRequest) {
    unlockRequest.submitting = true;
    unlockRequest.error = undefined;
    render();
  }
  try {
    await api("/api/vault/unlock", { password: value, create: false });
    closeUnlock(true);
  } catch (e) {
    if (unlockRequest) {
      unlockRequest.error =
        e instanceof Error ? e.message : "Could not unlock the vault.";
      unlockRequest.submitting = false;
    }
    render();
    password.focus();
  }
}

// ---- Actions: the same handlers as the imperative panel, dispatched by data-action ----
async function handleAction(action: string | undefined, id: string) {
  switch (action) {
    case "add":
      editing = "";
      render();
      return;
    case "edit":
      editing = id;
      render();
      return;
    case "machine-delete": {
      const machine = state.inventory.machines[id];
      if (!machine || machine.transport !== "ssh")
        throw new Error("This machine cannot be removed here. Refresh the list.");
      if (
        !(await confirm(
          `Remove ${id}?`,
          "This removes the machine from this device's inventory and generated SSH configuration. Other devices receive the removal for review during sync. The vault credential, the remote machine, and its installed SSH keys remain.",
        ))
      )
        return;
      await api("/api/machine/delete", { name: id });
      editing = undefined;
      await refresh();
      report(`Machine ${id} removed from this device.`, "notice");
      return;
    }
    case "cancel-edit":
      editing = undefined;
      render();
      return;
    case "navigate-peers":
      navigate("peers");
      return;
    case "doctor":
      result = await api("/api/doctor", { host: id });
      render();
      return;
    case "compare-conflict":
      conflictChoice[Number(id)] = undefined;
      render();
      return;
    case "close-task":
      permissionPeer = undefined;
      commandHost = undefined;
      commandPeer = "";
      render();
      return;
    case "command":
      commandHost = id;
      commandPeer = "";
      render();
      return;
    case "remote-command":
      commandHost = id;
      commandPeer = remoteHosts?.peerId ?? "";
      render();
      return;
    case "operation-approve":
      if (
        await confirm(
          "Execute this peer operation?",
          "You are approving the exact command, target, and impact shown in the request.",
        )
      )
        result = await api("/api/operation/decide", { id, approved: true });
      await refresh();
      return;
    case "operation-reject":
      await api("/api/operation/decide", { id, approved: false });
      await refresh();
      return;
    case "operation-status":
      if (operationResult) {
        result = await api("/api/peer/request", {
          id: operationResult.peerId,
          action: "operation-status",
          payload: { id: operationResult.id },
        });
        render();
      }
      return;
    case "pair-open":
      await api("/api/pair/open", {});
      await refresh();
      return;
    case "pair-copy-command":
      await copyText(`homectl pair --address ${pairingAddress()}`);
      report(
        "Command copied. Paste it on the other computer, then enter the one-time code.",
        "notice",
      );
      return;
    case "pair-copy-code":
      if (!state.pair?.code)
        throw new Error("The pairing code has expired. Start pairing again.");
      await copyText(state.pair.code);
      report(
        "One-time code copied. Paste it into the private pairing prompt.",
        "notice",
      );
      return;
    case "sync-copy-unlock":
      await copyText("homectl session unlock");
      report("Unlock command copied. Run it on the device named above.", "notice");
      return;
    case "pair-confirm":
      if (
        await confirm(
          "Trust this device?",
          "Both computers must show the same phrase. This grants sync access; remote operations stay disabled.",
        )
      )
        await api("/api/pair/confirm", {
          permissions: {
            sync: true,
            diagnostics: false,
            operations: [],
            administer: false,
          },
        });
      await refresh();
      return;
    case "pair-cancel":
      await api("/api/pair/cancel", {});
      await refresh();
      return;
    case "discovered":
      element<HTMLInputElement>("peer-address").value = id;
      element<HTMLInputElement>("pair-code").focus();
      return;
    case "peer-forget":
      if (
        await confirm(
          "Remove peer trust?",
          "Future syncs will be blocked. Previously copied SSH keys need separate rotation on the hosts.",
        )
      )
        await api("/api/peer/forget", { id });
      await refresh();
      return;
    case "peer-status": {
      const status = await api<{
        hosts: { name: string; description: string; access: string }[];
      }>("/api/peer/request", { id, action: "status", payload: {} });
      remoteHosts = { peerId: id, hosts: status.hosts };
      result = undefined;
      render();
      return;
    }
    case "peer-permissions":
      permissionPeer = id;
      render();
      return;
    case "sync-start":
      syncWaiting = undefined;
      syncPeerId = id;
      view = "sync";
      preview = await api<Preview>("/api/sync/start", { id });
      armSyncWait(preview);
      render();
      return;
    case "sync-preview":
      syncWaiting = undefined;
      syncPeerId = state.pending.find((pending) => pending.id === id)?.peerId;
      preview = await api<Preview>("/api/sync/preview", { id });
      armSyncWait(preview);
      render();
      return;
    case "sync-restart":
      if (!syncPeerId) throw new Error("Choose the device again to compare it.");
      if ((await updateSyncPreview(syncPeerId)) && !syncWaiting)
        report("Comparison updated. Review the changes before applying them.", "notice");
      return;
    case "sync-cancel":
      syncWaiting = undefined;
      await api("/api/sync/cancel", { id: preview?.id });
      preview = undefined;
      await refresh();
      return;
    case "control-tab":
      controlTab = id === "clients" ? "clients" : "queue";
      render();
      return;
    case "control-filter":
      controlFilter = id === "needs" || id === "history" ? id : "ready";
      render();
      return;
    case "control-verify":
      await api("/api/control/audit/verify", {});
      await refresh();
      return;
    case "control-execute": {
      const op = control?.operations.find((o) => o.operationId === id);
      if (!op) return;
      const title =
        op.classification === "destructive"
          ? "Run this destructive operation?"
          : op.classification === "inspect"
            ? "Run this inspection?"
            : "Run this change?";
      if (!(await confirm(title, "", <ExecutionDetails op={op} />))) return;
      const response = await api<ControlExecution>("/api/control/execute", {
        operationId: id,
      });
      controlResult = response;
      controlFilter = "history";
      await refresh();
      const label = displayStateOf(response.operation);
      const exit = response.operation.exitCode;
      announce(
        `Operation on ${response.operation.host} finished: ${label}${exit !== undefined ? `, exit ${exit}` : ""}. Result shown below.`,
      );
      focusScreen();
      return;
    }
    case "control-takeover": {
      const op = control?.operations.find((o) => o.operationId === id);
      if (!op?.takeover?.possible) return;
      const owner = op.ownerName ?? "the current owner";
      if (
        !(await confirm(
          `Take over ${op.host} on this device?`,
          `This device becomes the owner from ${owner}. The operation then needs a fresh approval here before it can run, and ${owner} is refused if it returns.`,
          <dl>
            <dt>Host</dt>
            <dd>{op.host}</dd>
            <dt>Command</dt>
            <dd>
              <code>{shellArgv(op.argv)}</code>
            </dd>
            <dt>Current owner</dt>
            <dd>{owner}</dd>
          </dl>,
        ))
      )
        return;
      await api("/api/control/handoff", { operationId: id });
      await refresh();
      announce(`Took over ${op.host}. It needs a fresh approval on this device.`);
      return;
    }
    case "control-handoff-open":
      handoffPicker = id;
      render();
      return;
    case "control-handoff-close":
      handoffPicker = undefined;
      render();
      return;
    case "control-handoff-go": {
      const op = control?.operations.find((o) => o.operationId === id);
      const target = element<HTMLSelectElement>("handoff-target");
      if (!op || !target.value) return;
      const name = target.selectedOptions[0]?.textContent ?? target.value;
      if (
        !(await confirm(
          `Offer ${op.host} to ${name}?`,
          `${name} must accept. Until it does, this device keeps the operation and will not run it. You can cancel the offer before it is accepted.`,
          <dl>
            <dt>Host</dt>
            <dd>{op.host}</dd>
            <dt>Command</dt>
            <dd>
              <code>{shellArgv(op.argv)}</code>
            </dd>
            <dt>Receiving device</dt>
            <dd>{name}</dd>
          </dl>,
        ))
      )
        return;
      await api("/api/control/handoff", { operationId: id, to: target.value });
      handoffPicker = undefined;
      await refresh();
      announce(`Offered ${op.host} to ${name}. It applies when ${name} accepts.`);
      return;
    }
    case "control-handoff-cancel": {
      const op = control?.operations.find((o) => o.operationId === id);
      if (
        !(await confirm(
          "Cancel the offer?",
          "The receiving device can no longer accept it. This device owns the operation again.",
        ))
      )
        return;
      await api("/api/control/handoff", { operationId: id, cancel: true });
      await refresh();
      announce(`Offer cancelled${op ? ` for ${op.host}` : ""}.`);
      return;
    }
    case "control-handoff-accept": {
      const op = control?.operations.find((o) => o.operationId === id);
      if (!op) return;
      const owner = op.ownerName ?? "the current owner";
      if (
        !(await confirm(
          `Accept the handoff of ${op.host}?`,
          `This device becomes the owner from ${owner}. The operation then needs a fresh approval here before it can run.`,
        ))
      )
        return;
      await api("/api/control/handoff", { operationId: id });
      await refresh();
      announce(`Accepted ${op.host}. It needs a fresh approval on this device.`);
      return;
    }
    case "control-resolve": {
      const select = document.querySelector<HTMLSelectElement>(
        `select[data-conflict-select="${CSS.escape(id)}"]`,
      );
      const owner = select?.value;
      if (!owner || !select) return;
      const name = select.selectedOptions[0]?.textContent ?? owner;
      if (
        !(await confirm(
          `Propose ${name} as the owner?`,
          `The proposal applies only when ${name} accepts it on its own device. Until then the operation has no owner and cannot run.`,
        ))
      )
        return;
      const answer = await api<{ accepted?: boolean }>("/api/control/resolve", {
        operationId: id,
        owner,
      });
      await refresh();
      announce(
        answer.accepted
          ? "Resolution applied on this device."
          : `Resolution proposed for ${name}; it applies once that device accepts.`,
      );
      return;
    }
    case "control-resolve-accept": {
      if (
        !(await confirm(
          "Accept this resolution?",
          "This device becomes the owner of the operation and needs a fresh approval here before it can run.",
        ))
      )
        return;
      await api("/api/control/resolve", { operationId: id });
      await refresh();
      announce("Resolution accepted on this device.");
      return;
    }
    case "control-peer-suspend": {
      const peer = control?.sync?.peers.find((p) => p.id === id);
      if (!peer) return;
      if (
        !(await confirm(
          `Suspend ${peer.name} from this device's lease?`,
          `Operations on this device may run without confirming ${peer.name} has seen the latest state. Use only if ${peer.name} is offline or will stay offline.`,
        ))
      )
        return;
      await api("/api/control/peer", { target: id, suspend: true });
      await refresh();
      announce(`${peer.name} is suspended from this device's lease.`);
      return;
    }
    case "control-peer-resume": {
      const peer = control?.sync?.peers.find((p) => p.id === id);
      if (!peer) return;
      if (
        !(await confirm(
          `Resume ${peer.name} in the lease?`,
          `${peer.name} counts toward this device's lease again, so operations here wait for it to sync.`,
        ))
      )
        return;
      await api("/api/control/peer", { target: id, suspend: false });
      await refresh();
      announce(`${peer.name} counts toward the lease again.`);
      return;
    }
    case "control-result-close":
      controlResult = undefined;
      render();
      return;
    case "control-revoke":
      if (
        await confirm(
          `Revoke ${id}?`,
          "Its token stops working immediately. To restore access later, create a new client from a terminal.",
        )
      )
        await api("/api/control/revoke", { id });
      await refresh();
      return;
    case "lock":
      await api("/api/vault/lock", {});
      await refresh();
      return;
  }
}

// Submitted forms, dispatched by form id (the connect and sync-unlock forms have their own handlers).
function handleSubmit(form: HTMLFormElement) {
  const values = new FormData(form);
  void task(async () => {
    let successMessage = "Changes saved.";
    if (form.id === "permissions-form" && permissionPeer) {
      const id = permissionPeer;
      const permissions = {
        sync: values.has("sync"),
        diagnostics: values.has("diagnostics"),
        administer: values.has("administer"),
        operations: values.getAll("hosts"),
      };
      if (
        !(await confirm(
          "Save peer grants",
          "You are granting the selected permissions for this computer and the listed hosts.",
        ))
      )
        return;
      await api("/api/peer/permissions", {
        id,
        address: values.get("address"),
        permissions,
      });
      permissionPeer = undefined;
    }
    if (form.id === "command-form" && commandHost) {
      const host = commandHost;
      const id = String(values.get("peer"));
      const program = String(values.get("program") ?? "").trim();
      if (!program) throw new Error("Enter the program to run.");
      const args = String(values.get("arguments") ?? "")
        .split(/\r?\n/)
        .filter((arg) => arg.length > 0);
      const argv = [program, ...args];
      const impact = String(values.get("impact"));
      const payload = { host, argv, impact, dryRun: true };
      const plan = await api<{
        plan: { classification: string; approval: string };
      }>(
        id ? "/api/peer/request" : "/api/exec",
        id ? { id, action: "exec", payload } : payload,
      );
      result = plan;
      render();
      if (
        !(await confirm(
          `Run on ${host}?`,
          `${displayArgv(argv)} · ${plan.plan.classification} · ${impact}`,
        ))
      )
        return;
      const done = await api<{ pending?: boolean; id: string }>(
        id ? "/api/peer/request" : "/api/exec",
        id
          ? { id, action: "exec", payload: { ...payload, dryRun: false } }
          : { ...payload, dryRun: false, approval: plan.plan.approval },
      );
      result = done;
      if (done.pending) operationResult = { id: done.id, peerId: id };
      render();
      return;
    }
    if (form.id === "key-form") {
      const password = String(values.get("password"));
      element<HTMLInputElement>("key-password").value = "";
      result = await api("/api/key/create", {
        name: values.get("name"),
        password,
      });
    }
    if (form.id === "pair-form") {
      const code = String(values.get("code"));
      element<HTMLInputElement>("pair-code").value = "";
      await api("/api/pair/join", { address: values.get("address"), code });
      successMessage =
        "Pairing request sent. Compare the verification phrase on both devices.";
    }
    if (form.id === "unlock-form") {
      const password = String(values.get("password"));
      element<HTMLInputElement>("password").value = "";
      const create = values.get("create") === "true";
      if (create) {
        const confirmation = String(values.get("password-confirm"));
        element<HTMLInputElement>("password-confirm").value = "";
        if (password !== confirmation)
          throw new Error("The passwords do not match. Try again.");
      }
      await api("/api/vault/unlock", { password, create });
      successMessage = create
        ? "Vault created and unlocked on this device."
        : "Vault unlocked. Credential sync is ready on this device.";
    }
    if (form.id === "settings-form") {
      const selection = String(values.get("ttl"));
      const customTtl = String(values.get("custom-ttl") ?? "").trim();
      const ttl = selection === "custom" ? customTtl : selection;
      if (selection === "custom" && !/^[1-9][0-9]{0,6}[smhd]$/.test(ttl))
        throw new Error("Enter a custom duration like 30m or 2d.");
      await api("/api/settings", { name: values.get("name"), ttl });
    }
    if (form.id === "machine-form") {
      const name = String(values.get("name"));
      const extra = JSON.parse(String(values.get("extra")));
      await api("/api/machine/save", {
        name,
        machine: {
          ...extra,
          transport: "ssh",
          ssh_alias: name,
          address: values.get("address"),
          user: values.get("user"),
          description: values.get("description"),
          access: values.get("access"),
        },
      });
      editing = undefined;
    }
    if (form.id === "sync-form" && preview) {
      const choices = Object.fromEntries(
        preview.conflicts.map((c, i) => [c.id, values.get(`choice-${i}`)]),
      );
      if (
        !(await confirm(
          "Apply this sync?",
          "Selected versions will be saved locally. The other peer receives the changes for its own review. Your SSH session will be locked.",
        ))
      )
        return;
      result = await api("/api/sync/apply", { id: preview.id, choices });
      preview = undefined;
    }
    await refresh();
    report(successMessage, "notice");
  });
}

// ---- App shell ----
const NAV: [string, string][] = [
  ["machines", "Machines"],
  ["peers", "Devices"],
  ["sync", "Sync"],
  ["access", "Access"],
  ["approvals", "Approvals"],
  ["settings", "Settings"],
];

function Screen() {
  if (permissionPeer) return <PermissionPanel id={permissionPeer} />;
  if (commandHost) return <CommandPanel host={commandHost} />;
  switch (view) {
    case "peers":
      return <Peers />;
    case "sync":
      return <SyncView />;
    case "access":
      return <Access />;
    case "approvals":
      return <Approvals />;
    case "settings":
      return <Settings />;
    default:
      return <Machines />;
  }
}

function Workspace() {
  const pendingCount = state.pending.length;
  const ready = (control?.operations ?? []).filter(
    (op) => isReady(op) && !op.runsOn,
  ).length;
  return (
    <div id="workspace" className="workspace">
      <aside className="rail">
        <a className="brand" href="#machines">
          <span className="brand-mark">h</span>homectl
        </a>
        <nav aria-label="Main navigation">
          {NAV.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              data-view={id}
              aria-current={view === id ? "page" : undefined}
            >
              {label}
              {id === "sync" ? (
                <>
                  {" "}
                  <span id="pending-count">
                    {pendingCount ? String(pendingCount) : ""}
                  </span>
                </>
              ) : null}
              {id === "approvals" ? (
                <>
                  {" "}
                  <span id="approval-count">{ready ? String(ready) : ""}</span>
                </>
              ) : null}
            </a>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="live-dot"></span> Local workspace
          <p id="rail-device">{state.device.name}</p>
          <span className="muted">CLI + peer sync</span>
        </div>
      </aside>
      <div className="workarea">
        <header className="toolbar">
          <div className="device-context">
            <span className="device-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="13" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </span>
            <span id="device-name">{state.device.name}</span>
            <span id="device-platform" className="muted">
              {state.device.platform}
            </span>
          </div>
          <div className="toolbar-actions">
            <span
              id="session-state"
              className={`badge ${state.session.unlocked ? "success" : ""}`}
            >
              {state.session.unlocked ? "SSH unlocked" : "SSH locked"}
            </span>
            <button
              id="lock"
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  await api("/api/vault/lock", {});
                  await refresh();
                })
              }
            >
              Lock
            </button>
            <button
              id="refresh"
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => void task(refresh)}
            >
              Refresh
            </button>
          </div>
        </header>
        <main id="content" tabIndex={-1}>
          <div id="error" role="alert" hidden={!banners.error}>
            {banners.error}
          </div>
          <div id="notice" role="status" hidden={!banners.notice}>
            {banners.notice}
          </div>
          <div id="screen">
            <Screen />
          </div>
        </main>
      </div>
    </div>
  );
}

function Connection() {
  return (
    <div id="connection" className="connection">
      <div className="connection-form">
        <div className="brand">
          <span className="brand-mark">h</span>homectl
        </div>
        <h1>
          Your homelab.
          <br />
          Across your devices.
        </h1>
        <p>
          Open this workspace at <code id="workspace-origin">{location.origin}</code>.
          For a local workspace, run <code>homectl panel</code> in a private
          terminal and open its link. For a Compose deployment, enter the code
          stored in the protected file configured as{" "}
          <code>HOMECTL_PANEL_TOKEN_FILE</code> or{" "}
          <code>--panel-token-file</code>.
        </p>
        <div id="connection-error" role="alert" hidden={!banners.connection}>
          {banners.connection}
        </div>
        <form
          id="connect-form"
          onSubmit={(event) => {
            event.preventDefault();
            void task(async () => {
              const input = element<HTMLInputElement>("token");
              const token = input.value;
              input.value = "";
              await api("/api/connect", { token });
              await refresh();
            });
          }}
        >
          <label htmlFor="token">Workspace access code</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            required
          />
          <button className="primary" type="submit">
            Open workspace
          </button>
        </form>
        <p className="muted">
          This code opens the workspace; it is separate from the KeePass password
          and one-time pairing code. After connecting, pair devices from the
          Devices page.
        </p>
      </div>
    </div>
  );
}

function App() {
  useSyncExternalStore(subscribe, snapshot);
  // Focus the screen heading after a user action, as the imperative panel did.
  useEffect(() => {
    if (!focusPending) return;
    focusPending = false;
    const card = document.getElementById("control-result");
    if (card) {
      card.scrollIntoView({ block: "nearest" });
      card.focus({ preventScroll: true });
      return;
    }
    const heading = document.querySelector<HTMLElement>("#screen h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  });
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      {connected ? null : <Connection />}
      <div id="control-live" className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
      {connected && state !== undefined ? <Workspace /> : null}
      <ConfirmDialog />
      <UnlockDialog />
    </>
  );
}

// Delegated handlers for the whole panel. Buttons and links carry data-action,
// data-view or data-id; form fields are read by id when a form is submitted.
function onRootClick(event: ReactMouseEvent<HTMLDivElement>) {
  const target = (event.target as Element).closest<HTMLElement>(
    "[data-action],[data-view]",
  );
  if (!target) return;
  if (target.dataset.view) {
    event.preventDefault();
    navigate(target.dataset.view);
    return;
  }
  const action = target.dataset.action;
  const id = target.dataset.id ?? "";
  void task(() => handleAction(action, id));
}

function onRootSubmit(event: FormEvent<HTMLDivElement>) {
  const form = event.target as HTMLFormElement;
  if (
    form.id === "connect-form" ||
    form.id === "sync-unlock-form" ||
    !form.id
  )
    return;
  event.preventDefault();
  handleSubmit(form);
}

function onRootInput(event: FormEvent<HTMLDivElement>) {
  void event;
}

function onRootChange(event: FormEvent<HTMLDivElement>) {
  // Conflict choice: show the chosen version and hide the comparison.
  const radio = event.target as HTMLInputElement;
  if (!radio.name.startsWith("choice-")) return;
  conflictChoice[Number(radio.name.slice(7))] = radio.value;
  render();
}

async function boot() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    history.replaceState(null, "", location.pathname);
    try {
      await api("/api/connect", { token });
    } catch (e) {
      report(String(e));
    }
  }
  try {
    await refresh();
  } catch {
    connected = false;
    render();
  }
  view = [
    "machines",
    "peers",
    "sync",
    "access",
    "approvals",
    "settings",
  ].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : "machines";
  render();
}

createRoot(element("root")).render(
  <div
    className="panel-root"
    onClick={onRootClick}
    onSubmit={onRootSubmit}
    onInput={onRootInput}
    onChange={onRootChange}
  >
    <App />
  </div>,
);
void boot().then(() => {
  window.setInterval(() => void pollPairing(), 2000);
  window.setInterval(() => void pollSyncReadiness(), 2000);
});
