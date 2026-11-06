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
let view = "machines";
let editing: string | undefined;
let result: unknown;
let busy = false;
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
};
type ControlOverview = {
  operations: ControlOp[];
  clients: ControlClient[];
  audit: ControlAudit;
  sync?: ControlSync;
  devices?: ControlDevices;
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
function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function button(action: string, label: string, id = "", kind = "secondary") {
  return `<button type="button" class="${kind}" data-action="${action}" data-id="${htmlEscape(id)}">${label}</button>`;
}
function heading(title: string, description: string, actions = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${actions}</div></div>`;
}
async function api<T = unknown>(path: string, value?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: value === undefined ? "GET" : "POST",
    headers: value === undefined ? {} : { "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? "The operation failed");
  return v as T;
}
function report(message: string, kind = "error") {
  const target =
    kind === "error" && element("workspace").hidden ? "connection-error" : kind;
  const e = element(target);
  e.textContent =
    target === "connection-error"
      ? `${message} Open homectl panel in a private terminal to get a fresh access link, then retry.`
      : message;
  e.hidden = false;
}
async function task(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  for (const id of ["error", "notice", "connection-error"])
    element(id).hidden = true;
  const disabled = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].filter((b) => !b.closest("dialog") && !b.disabled);
  for (const b of disabled) b.disabled = true;
  try {
    await fn();
  } catch (e) {
    report(
      e instanceof Error
        ? e.message
        : "The operation failed. Refresh the workspace and try again.",
    );
  } finally {
    busy = false;
    for (const b of disabled) b.disabled = false;
  }
}
async function refresh() {
  state = await api<State>("/api/state");
  element("connection").hidden = true;
  element("workspace").hidden = false;
  element("device-name").textContent = state.device.name;
  element("device-platform").textContent = state.device.platform;
  element("rail-device").textContent = state.device.name;
  const s = element("session-state");
  s.textContent = state.session.unlocked ? "SSH unlocked" : "SSH locked";
  s.className = `badge ${state.session.unlocked ? "success" : ""}`;
  element("pending-count").textContent = state.pending.length
    ? String(state.pending.length)
    : "";
  control = await api<ControlOverview>("/api/control").catch(() => undefined);
  // Only operations this device can run count toward the badge.
  const ready = (control?.operations ?? []).filter(
    (op) => isReady(op) && !op.runsOn,
  ).length;
  element("approval-count").textContent = ready ? String(ready) : "";
  render();
}
function render() {
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const screen = element("screen");
  screen.innerHTML = permissionPeer
    ? permissionPanel(permissionPeer)
    : commandHost
      ? commandPanel(commandHost)
      : view === "machines"
        ? machines()
        : view === "peers"
          ? peers()
          : view === "sync"
            ? sync()
            : view === "access"
              ? access()
              : view === "approvals"
                ? approvals()
                : settings();
  const focus = screen.querySelector<HTMLElement>("h1");
  if (focus) {
    focus.tabIndex = -1;
    focus.focus({ preventScroll: true });
  }
}
// Fingerprint of a peer's signing key, or the re-pair hint for a legacy peer.
function signingNote(id: string) {
  const device = control?.devices?.peers.find((p) => p.id === id);
  if (!device)
    return `<p class="inline-note">Signing key not reported yet.</p>`;
  return device.legacy
    ? `<p class="inline-note">Re-pair this device to enable control sync; it has no signing key.</p>`
    : `<p class="inline-note">Signing key <code>${htmlEscape(device.fingerprint ?? "")}</code></p>`;
}
function permissionPanel(id: string) {
  const p = state.peers.find((p) => p.id === id);
  if (!p) return "";
  return `${heading(`Permissions: ${htmlEscape(p.name)}`, "These grants define what this peer can do on this computer.")}<section class="panel"><form id="permissions-form"><label for="permission-address">Peer address</label><input id="permission-address" name="address" value="${htmlEscape(p.address)}" required><label class="check"><input name="sync" type="checkbox" ${p.permissions.sync ? "checked" : ""}>Sync entries</label><label class="check"><input name="diagnostics" type="checkbox" ${p.permissions.diagnostics ? "checked" : ""}>Inspect this device and its hosts</label><label class="check"><input name="administer" type="checkbox" ${p.permissions.administer ? "checked" : ""}>Operate on the computer running homectl</label><h3 class="section">Hosts available for operations</h3>${Object.entries(
    state.inventory.machines,
  )
    .map(
      ([name, m]) =>
        `<label class="check"><input name="hosts" value="${htmlEscape(name)}" type="checkbox" ${p.permissions.operations.includes(name) ? "checked" : ""}>${htmlEscape(name)} <span class="muted">${htmlEscape(m.access)}</span></label>`,
    )
    .join(
      "",
    )}<p class="inline-note">Changes require additional approval here, on the execution device.</p><div class="form-actions">${button("close-task", "Cancel")}<button class="primary">Save permissions</button></div></form></section>`;
}
function commandPanel(host: string) {
  return `${heading(`Command: ${htmlEscape(host)}`, "Review the exact arguments and target before executing.")}<section class="panel"><form id="command-form" class="stack"><div><label for="command-peer">Execution device</label><select id="command-peer" name="peer"><option value="">${htmlEscape(state.device.name)} · local</option>${state.peers.map((p) => `<option value="${p.id}" ${commandPeer === p.id ? "selected" : ""}>${htmlEscape(p.name)} · peer</option>`).join("")}</select></div><div><label for="command-args">Command arguments (JSON array)</label><textarea id="command-args" name="argv" required>["uname", "-s"]</textarea></div><div><label for="command-impact">Purpose and expected impact</label><input id="command-impact" name="impact" placeholder="For example: inspect the OS or restart a specific service"></div><p class="inline-note">The peer must grant access to this host. Changes also need approval in its local workspace.</p><div class="form-actions">${button("close-task", "Close")}<button class="primary">Review and execute</button></div></form></section>${output()}`;
}
function machines() {
  const hosts = Object.entries(state.inventory.machines);
  let content = heading(
    "Machines",
    "Your SSH hosts and this device. Every operation has an explicit target.",
    button("add", "Add machine", "", "primary"),
  );
  if (state.operations?.length)
    content += `<section class="panel section"><h2>Operations awaiting your approval</h2>${state.operations.map((o) => `<div class="peer-row"><div><strong>${htmlEscape(o.peerName)} → ${htmlEscape(o.host)}</strong><pre>${htmlEscape(JSON.stringify(o.argv))}</pre><p>${htmlEscape(o.impact ?? "Review the exact target and impact")}</p></div><div class="actions">${button("operation-approve", "Approve", o.id, "primary")}${button("operation-reject", "Reject", o.id)}</div></div>`).join("")}</section>`;
  if (editing !== undefined) {
    const m = state.inventory.machines[editing];
    return (
      content +
      `<section class="panel"><h2>${m ? "Edit machine" : "Add SSH host"}</h2><p class="muted">Prepare a key with <code>homectl key create &lt;name&gt;</code>, install its public key on the host, and verify the host fingerprint.</p><form id="machine-form" class="form-grid"><div><label for="machine-name">Name</label><input id="machine-name" name="name" pattern="[a-z][a-z0-9-]{0,62}" value="${htmlEscape(editing)}" required ${m ? "readonly" : ""}></div><div><label for="machine-address">Address</label><input id="machine-address" name="address" value="${htmlEscape(m?.address)}" required></div><div><label for="machine-user">SSH account</label><input id="machine-user" name="user" value="${htmlEscape(m?.user)}" required></div><div><label for="machine-access">Access</label><select id="machine-access" name="access">${["observe", "user", "sudo-approved", "full"].map((a) => `<option ${m?.access === a ? "selected" : ""}>${a}</option>`).join("")}</select></div><div class="full"><label for="machine-description">Description</label><input id="machine-description" name="description" value="${htmlEscape(m?.description)}" required></div><div class="full"><label for="machine-json">Advanced fields (JSON: auth from key inspect, port, caution, sudo_allow)</label><textarea id="machine-json" name="extra">${htmlEscape(JSON.stringify(m ? Object.fromEntries(Object.entries(m).filter(([k]) => !["address", "user", "description", "access", "transport", "ssh_alias"].includes(k))) : {}, null, 2))}</textarea></div><div class="full form-actions">${button("cancel-edit", "Cancel")}<button class="primary" type="submit">Save machine</button></div></form></section>`
    );
  }
  content += `<div class="filters"><label class="muted" for="filter">Find a machine</label><input id="filter" type="search" placeholder="Name, address, or description" autocomplete="off"></div>`;
  if (!hosts.length)
    return (
      content +
      `<div class="empty"><h2>Add your first machine</h2><p>Prepare an SSH key and add a host. If another computer already has your setup, pair the devices and sync their entries.</p>${button("navigate-peers", "Pair a device", "", "primary")}</div>`
    );
  content += `<div class="table-wrap"><table><thead><tr><th>Machine</th><th>Connection</th><th>Access</th><th><span class="muted">Operations</span></th></tr></thead><tbody>${hosts.map(([name, m]) => `<tr data-search="${htmlEscape([name, m.address, m.description].join(" ").toLowerCase())}"><td class="name-cell"><span class="host-avatar" aria-hidden="true">${htmlEscape(name.slice(0, 2).toUpperCase())}</span><span class="name-content">${htmlEscape(name)}<p>${htmlEscape(m.description)}</p><details class="machine-details"><summary>Details</summary><dl><dt>Transport</dt><dd>${htmlEscape(m.transport)}</dd><dt>SSH account</dt><dd>${htmlEscape(m.user ?? "Local")}</dd><dt>Port</dt><dd>${htmlEscape(m.port ?? 22)}</dd><dt>SSH alias</dt><dd>${htmlEscape(m.ssh_alias ?? "—")}</dd><dt>Cautions</dt><dd>${htmlEscape(Array.isArray(m.caution) ? m.caution.join("; ") : "None recorded")}</dd></dl></details></span></td><td>${m.transport === "local" ? "This device" : `<code>${htmlEscape(m.address)}</code><p>${htmlEscape(m.user)} · SSH</p>`}</td><td><span class="badge">${htmlEscape(m.access)}</span></td><td><div class="actions">${button("doctor", "Check", name)}${button("command", "Command", name)}${m.transport === "ssh" ? button("edit", "Edit", name, "quiet") : ""}</div></td></tr>`).join("")}</tbody></table></div>`;
  return content + output();
}
function peers() {
  const p = state.pair;
  return (
    heading(
      "Devices",
      "Equal peers. Syncing entries and running operations have separate permissions.",
      button("pair-open", "Start pairing", "", "primary"),
    ) +
    `${p ? `<section class="panel"><h2>${p.sas ? "Verify this device" : "Pairing window open"}</h2><p class="muted">Expires at ${new Date(p.expiresAt).toLocaleTimeString("en-GB")}.</p>${p.code ? `<p>On the other computer, select this device and enter the code:</p><div class="pair-code">${htmlEscape(p.code)}</div><p class="inline-note">Do not send this code in chat or save it in logs.</p>` : ""}${p.sas ? `<p>Compare this verification phrase on both computers. Device: <strong>${htmlEscape(p.remote?.name)}</strong>.</p><div class="verification">${htmlEscape(p.sas)}</div><p>${p.localConfirmed ? "Local confirmation saved." : "Confirm only if both devices show the same phrase."} ${p.remoteConfirmed ? "The other device has confirmed." : "Waiting for the other device."}</p>${!p.localConfirmed ? button("pair-confirm", "The phrases match", "", "primary") : button("pair-poll", "Check confirmation")}` : ""}<div class="form-actions">${button("pair-cancel", "Close pairing")}</div></section>` : ""}<section class="section split"><div class="panel"><h2>Devices on your LAN</h2>${state.discovery.devices.length ? state.discovery.devices.map((d) => `<div class="peer-row"><div><strong>Device ready to pair</strong><p>${htmlEscape(d.address)}</p></div>${button("discovered", "Select", d.address)}</div>`).join("") : `<p class="muted">No devices with an open pairing window found.</p><p class="inline-note">${htmlEscape(state.discovery.error ?? "Open pairing on the other computer, or enter its IP address.")}</p>`}</div><div class="panel"><h2>Join a pairing session</h2><form id="pair-form" class="stack"><div><label for="peer-address">Other computer’s address</label><input id="peer-address" name="address" placeholder="http://192.168.1.10:7448" required></div><div><label for="pair-code">One-time code</label><input id="pair-code" name="code" inputmode="numeric" placeholder="1234-5678" autocomplete="off" required></div><button class="primary">Connect and compare phrases</button></form></div></section><section class="section"><h2>Paired devices</h2>${control?.devices ? `<p class="inline-note">This device signs control records with <code>${htmlEscape(control.devices.self.fingerprint ?? "no key yet")}</code>.</p>` : ""}${state.peers.length ? `<div class="panel peer-list">${state.peers.map((peer) => `<div class="peer-row"><div><strong>${htmlEscape(peer.name)}</strong> <span class="badge">${htmlEscape(peer.platform)}</span><p>${htmlEscape(peer.address)}</p>${signingNote(peer.id)}<p>${peer.permissions.sync ? "Sync" : "Sync disabled"} · ${peer.permissions.diagnostics ? "Diagnostics" : "Diagnostics disabled"} · operations: ${peer.permissions.operations.length}</p></div><div class="actions">${button("sync-start", "Sync", peer.id)}${button("peer-status", "Status", peer.id)}${button("peer-permissions", "Permissions", peer.id, "quiet")}${button("peer-forget", "Remove trust", peer.id, "quiet danger")}</div></div>`).join("")}</div>` : `<div class="empty"><h2>No paired devices yet</h2><p>Open pairing on one computer and enter its code on the other. Confirm on both devices to establish mutual trust.</p></div>`}</section>` +
    output()
  );
}
function sync() {
  let s = heading(
    "Sync",
    "Changes flow both ways. Review the scope and resolve conflicts before applying.",
  );
  if (preview) {
    s += `<section class="panel"><h2>${htmlEscape(preview.localName)} ↔ ${htmlEscape(preview.remoteName)}</h2><p class="muted">${preview.changes.length} changed entries · ${preview.conflicts.length} conflicts. Secrets stay hidden.</p><form id="sync-form">${preview.conflicts.map((c, i) => `<section class="conflict" data-conflict="${i}"><h3>${htmlEscape(c.id)}</h3><div class="split"><div class="version"><h3>${htmlEscape(preview?.localName)} <span class="badge">Local</span></h3><pre>${htmlEscape(JSON.stringify(c.local.value, null, 2))}</pre></div><div class="version"><h3>${htmlEscape(preview?.remoteName)} <span class="badge">Received</span></h3><pre>${htmlEscape(JSON.stringify(c.remote.value, null, 2))}</pre></div></div><div class="choice">${[["local", `Use from ${preview?.localName}`], ["remote", `Use from ${preview?.remoteName}`], ...(c.id.startsWith("hostkey:") ? [] : [["both", "Keep both as separate entries"]])].map(([value, label]) => `<label><input type="radio" name="choice-${i}" value="${value}" required>${htmlEscape(label)}</label>`).join("")}</div></section>`).join("")}<details><summary>Changes to review</summary><pre>${htmlEscape(JSON.stringify(preview.entries ?? preview.changes, null, 2))}</pre></details><div class="form-actions">${button("sync-cancel", "Cancel")}<button class="primary">Apply selected changes</button></div></form></section>`;
  } else {
    s += state.pending.length
      ? `<section class="panel"><h2>Awaiting your review</h2>${state.pending.map((p) => `<div class="peer-row"><div><strong>${htmlEscape(p.remoteName)}</strong><p>A peer is proposing changes. Open the comparison before applying them.</p></div>${button("sync-preview", "Review", p.id)}</div>`).join("")}</section>`
      : `<div class="empty"><h2>You decide what changes</h2><p>Choose a paired device to compare entries. Unlock both vaults to sync SSH credentials.</p>${button("navigate-peers", "Choose a device", "", "primary")}</div>`;
  }
  return s + controlSyncSection() + output();
}
// Continuous control sync: approvals and executions travel on it. Shows each
// device's last sync, backoff, lease and refusals, plus control conflicts.
function controlSyncSection() {
  if (!control)
    return `<section class="panel section"><h2>Control sync</h2><p class="muted">Control status is unavailable right now. Refresh to try again.</p></section>`;
  const sync = control.sync;
  if (sync?.disabledBy)
    return `<section class="panel section"><h2>Control sync</h2><p class="muted">Control sync is disabled by ${htmlEscape(sync.disabledBy)} on this device. Operations that have paired peers wait for a sync.</p></section>`;
  if (!sync?.running)
    return `<section class="panel section"><h2>Control sync</h2><p class="muted">Control sync runs while homectl serve is running on this device.</p></section>`;
  const now = Date.now();
  const names = sync.names ?? {};
  const rows = sync.peers.length
    ? `<div class="table-wrap"><table><thead><tr><th>Device</th><th>Last sync</th><th>Lease</th><th>Backoff</th><th>Status</th><th>Action</th></tr></thead><tbody>${sync.peers
        .map((p) => syncRow(p, now))
        .join("")}</tbody></table></div>`
    : `<p class="muted">No paired devices take part in control sync yet.</p>`;
  const conflicts = sync.conflicts.length
    ? `<h3 class="section">Control conflicts</h3><p class="inline-note">Two different handoffs were recorded for the same operation. Nobody can run it until the conflict is resolved. Choose the owner here; that device must accept on its own side before the resolution applies.</p>${sync.conflicts
        .map((c) => conflictRow(c, names, sync.resolutions ?? []))
        .join("")}`
    : `<p class="inline-note">No control conflicts.</p>`;
  const blocked = Object.entries(sync.blocked)
    .map(
      ([origin, reason]) =>
        `<p class="inline-note">Log from ${htmlEscape(names[origin] ?? origin)} is blocked: ${htmlEscape(reason)}</p>`,
    )
    .join("");
  return `<section class="panel section"><h2>Control sync</h2><p class="muted">Approvals and executions travel on this sync. It runs every 15 seconds while homectl serve runs.</p>${rows}${conflicts}${blocked}</section>`;
}
// One paired device. A suspended device is out of this device's lease until it
// syncs again or is resumed; a legacy device has no control sync at all.
function syncRow(p: ControlSync["peers"][number], now: number) {
  const name = `<td data-label="Device"><strong>${htmlEscape(p.name)}</strong></td>`;
  const lastSync =
    p.lastSync === undefined
      ? `<span class="muted">never</span>`
      : htmlEscape(relative(new Date(p.lastSync).toISOString()));
  if (p.suspended)
    return `<tr>${name}<td data-label="Last sync">${lastSync}</td><td data-label="Lease"><span class="warn-text">suspended by ${htmlEscape(p.suspended.by)} at ${htmlEscape(localStamp(p.suspended.at))}</span></td><td data-label="Backoff"><span class="muted">—</span></td><td data-label="Status"><span class="muted">not counted in the lease</span></td><td data-label="Action" class="cell-action">${button("control-peer-resume", "Resume", p.id, "quiet")}</td></tr>`;
  if (p.excluded)
    return `<tr>${name}<td data-label="Last sync"><span class="muted">never (control)</span></td><td data-label="Lease"><span class="muted">excluded from lease: re-pair required</span></td><td data-label="Backoff"><span class="muted">—</span></td><td data-label="Status"><span class="badge warning" title="${htmlEscape(p.refused ?? "")}">re-pair required</span></td><td data-label="Action"><span class="muted">—</span></td></tr>`;
  const retry =
    p.nextAttemptAt !== undefined &&
    (p.failures ?? 0) > 0 &&
    p.nextAttemptAt > now
      ? `retry ${localStamp(new Date(p.nextAttemptAt).toISOString())}`
      : "none";
  const status = p.lastError
    ? `<span class="danger">${htmlEscape(p.lastError)}</span>`
    : `<span class="badge success">ok</span>`;
  return `<tr>${name}<td data-label="Last sync">${lastSync}</td><td data-label="Lease">${p.leaseOk ? "ok" : `<span class="danger">expired: waiting for sync</span>`}</td><td data-label="Backoff">${htmlEscape(retry)}</td><td data-label="Status">${status}</td><td data-label="Action" class="cell-action">${button("control-peer-suspend", "Suspend from lease", p.id, "quiet danger")}</td></tr>`;
}
// One conflicting operation: its candidates, any proposal waiting, and the
// owner choice (any device involved can propose; the chosen one must accept).
function conflictRow(
  c: { opId: string; epoch: number; candidates: string[] },
  names: Record<string, string>,
  resolutions: NonNullable<ControlSync["resolutions"]>,
) {
  const mine = resolutions.filter((r) => r.opId === c.opId);
  const proposals = mine
    .map(
      (r) =>
        `<p class="inline-note">Proposed by ${htmlEscape(names[r.resolver] ?? r.resolver)}: owner ${htmlEscape(names[r.winner] ?? r.winner)}.</p>`,
    )
    .join("");
  const accept = mine.some((r) => r.waitingForSelf)
    ? button("control-resolve-accept", "Accept resolution", c.opId, "primary")
    : "";
  const options = c.candidates
    .map(
      (id) =>
        `<option value="${htmlEscape(id)}">${htmlEscape(names[id] ?? id)}</option>`,
    )
    .join("");
  return `<div class="peer-row conflict-row"><div class="conflict-text"><strong><code>${htmlEscape(c.opId.slice(0, 8))}</code></strong> at epoch ${c.epoch}: ${htmlEscape(c.candidates.map((id) => names[id] ?? id).join(", "))}${proposals}</div><div class="conflict-controls">${accept}<label class="sr-only" for="resolve-${htmlEscape(c.opId)}">Owner for ${htmlEscape(c.opId.slice(0, 8))}</label><select id="resolve-${htmlEscape(c.opId)}" data-conflict-select="${htmlEscape(c.opId)}">${options}</select>${button("control-resolve", "Resolve…", c.opId, "quiet")}</div></div>`;
}
function access() {
  return (
    heading(
      "Access",
      "Vaults and sessions are local. Pairing does not unlock the other computer.",
    ) +
    `<div class="split"><section class="panel"><h2>Encrypted vault</h2><p class="muted">${state.vaultUnlocked ? "The local vault is unlocked for syncing." : "Unlock the vault to sync credential entries."}</p><form id="unlock-form" class="stack"><div><label for="password">Local KeePassXC password</label><input id="password" name="password" type="password" autocomplete="off" required></div><label class="check"><input type="checkbox" name="create">Create a vault if it does not exist</label><button class="primary">Unlock locally</button></form><p class="inline-note">Your password is never sent to peers or saved in logs. Private keys never reach the browser.</p></section><section class="panel"><h2>SSH session</h2><dl><dt>Status</dt><dd>${state.session.unlocked ? "Unlocked" : "Locked"}</dd><dt>Expires</dt><dd>${state.session.unlocked ? (state.session.expiresAt ? new Date(state.session.expiresAt).toLocaleString("en-GB") : "On lock or restart") : "—"}</dd><dt>TTL</dt><dd>${htmlEscape(state.inventory.session?.ttl ?? "24h")}</dd></dl><div class="form-actions">${button("lock", "Lock access")}</div><p class="inline-note">Locking stops new authentication. Established SSH connections may continue.</p><h3 class="section">New key</h3><p class="muted">Run privately <code>homectl key create &lt;name&gt;</code>. View public keys with <code>homectl key inspect &lt;name&gt;</code>.</p></section></div><section class="section panel"><h2>Create an SSH key</h2><p class="muted">The private key is saved in your local encrypted vault. Install only its public key on the host through your existing trusted access.</p><form id="key-form" class="form-grid"><div><label for="key-name">Key and machine name</label><input id="key-name" name="name" pattern="[a-z][a-z0-9-]{0,62}" placeholder="storage-nas" required></div><div><label for="key-password">Local vault password</label><input id="key-password" name="password" type="password" autocomplete="off" required></div><div class="full form-actions"><button class="primary">Create key and show public key</button></div></form><p class="inline-note">Creating a key locks the current session. Unlock again after enrolling the host.</p></section>` +
    output()
  );
}
function settings() {
  return (
    heading(
      "Settings",
      "This device’s identity, session lifetime, and background execution.",
    ) +
    `<div class="split"><section class="panel"><h2>This device</h2><form id="settings-form" class="stack"><div><label for="device-label">Device name</label><input id="device-label" name="name" value="${htmlEscape(state.device.name)}" maxlength="100" required></div><div><label for="ttl">Session lifetime</label><input id="ttl" name="ttl" value="${htmlEscape(state.inventory.session?.ttl ?? "24h")}" required><p class="inline-note">For example: 12h, 24h, or until-reboot. Changing this locks the current session.</p></div><button class="primary">Save settings</button></form></section><section class="panel"><h2>Server and service</h2><dl><dt>Peer channel</dt><dd><code>${htmlEscape(state.address)}</code></dd><dt>Panel</dt><dd>Localhost only</dd><dt>Identity</dt><dd><code>${htmlEscape(state.device.id)}</code></dd></dl><h3 class="section">Run in the background</h3><p class="muted">Install from a terminal. The service uses this workspace and starts with locked keys.</p><pre>homectl service install --interface &lt;LAN-IP&gt;\nhomectl service start\nhomectl service status</pre><p class="inline-note">Windows requires WinSW and a configured service account. WSL requires systemd. Details: docs/windows.md.</p></section></div>`
  );
}
// Approvals: the control plane's queue. Approval always comes from another
// MCP client; this panel only runs work that is already ready to run.
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
function stateBadge(label: string) {
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
  return `<span class="badge ${kind}">${htmlEscape(label)}</span>`;
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
function opAction(op: ControlOp) {
  // An operation that another device owns runs there; it is never executed here.
  if (op.runsOn) {
    const expired =
      op.offerExpires !== undefined &&
      Date.parse(op.offerExpires) <= Date.now();
    const accept =
      op.offerFrom && !expired
        ? button(
            "control-handoff-accept",
            "Accept handoff",
            op.operationId,
            "primary",
          )
        : "";
    const offer = op.offerFrom
      ? `<div class="sub muted">Offered by ${htmlEscape(op.runsOn)}; ${htmlEscape(offerExpiry(op))}</div>`
      : "";
    const takeover = op.takeover?.possible
      ? button("control-takeover", "Take over here", op.operationId, "quiet")
      : op.takeover
        ? `<span class="muted">${htmlEscape(takeoverText(op))}</span>`
        : "";
    const extra =
      accept || takeover ? `<div class="sub">${accept}${takeover}</div>` : "";
    return `<span class="muted">Runs on ${htmlEscape(op.runsOn)}</span>${offer}${extra}`;
  }
  if (op.conflict)
    return `<span class="muted">${htmlEscape(takeoverText(op))}</span>`;
  // An open offer stops execution here until the receiver accepts, it is cancelled, or it expires.
  if (op.offerTo)
    return `<span class="muted">Offered to ${htmlEscape(op.offerTo)}; not runnable here</span><div class="sub muted">${htmlEscape(offerExpiry(op))}</div><div class="sub">${button("control-handoff-cancel", "Cancel offer", op.operationId, "quiet danger")}</div>`;
  const handoff =
    op.remote || bucketOf(op) === "history"
      ? ""
      : `<div class="sub">${button("control-handoff-open", "Hand off…", op.operationId, "quiet")}</div>`;
  return `${primaryAction(op)}${handoff}`;
}
// "offer expires in 12 min" or "offer expired 2 min ago".
function offerExpiry(op: ControlOp) {
  return op.offerExpires ? `offer ${relative(op.offerExpires, true)}` : "";
}
function primaryAction(op: ControlOp) {
  // Inspection is the primary action; changes get a distinct warning outline.
  if (isReady(op))
    return button(
      "control-execute",
      "Execute",
      op.operationId,
      op.classification === "inspect" ? "primary" : "change",
    );
  if (op.state === "pending")
    return `<span class="muted">Waiting for approval by another client</span>`;
  if (op.state === "executing") return `<span class="muted">Running…</span>`;
  if (op.state === "succeeded")
    return `<span class="muted">Exit ${op.exitCode ?? 0}</span>`;
  return `<span class="muted">${htmlEscape(op.reason ?? "Closed")}${op.exitCode !== undefined ? ` · exit ${op.exitCode}` : ""}</span>`;
}
function classBadge(op: ControlOp) {
  const kind =
    op.classification === "destructive"
      ? "danger"
      : op.classification === "inspect"
        ? ""
        : "warning";
  return `<span class="badge ${kind}">${htmlEscape(op.classification)}</span>`;
}
// Six columns at 1280px: class sits under the state, impact and fingerprint
// under the command, and the requested cell is two lines at most.
function opRow(op: ControlOp) {
  const label = displayStateOf(op);
  const open = op.state === "pending" || op.state === "approved";
  const expiresAt =
    op.state === "approved" && op.approval
      ? op.approval.expiresAt
      : op.expiresAt;
  // Remote operations have no local expiry; they show when they last changed.
  const when =
    open && !op.remote ? relative(expiresAt, true) : relative(op.updatedAt);
  const approver = op.approval
    ? htmlEscape(op.approval.approver)
    : op.approvedBy
      ? htmlEscape(op.approvedBy)
      : op.delivery?.status === "awaiting-confirmation"
        ? `<span class="muted">forwarded, awaiting confirmation</span>`
        : op.needsApproval
          ? `<span class="muted">awaiting approval</span>`
          : `<span class="muted">not needed</span>`;
  const actionLabel = bucketOf(op) === "history" ? "Result" : "Action";
  const owner = op.ownerName
    ? `<span class="sub">owner ${htmlEscape(op.ownerName)}</span>`
    : "";
  return `<tr><td data-label="State"><div>${stateBadge(label)}</div><div class="cls">${classBadge(op)}</div></td><td data-label="Host" class="nowrap"><strong>${htmlEscape(op.host)}</strong>${owner}</td><td data-label="Command" class="cell-command"><code class="cmd">${htmlEscape(shellArgv(op.argv))}</code><p class="impact">${htmlEscape(op.impact || "—")}</p><span class="fp" title="${htmlEscape(op.fingerprint)}">fingerprint ${htmlEscape(shortHash(op.fingerprint))}</span></td><td data-label="Requested → approved" class="cell-people"><span class="person">${htmlEscape(op.issuer)}</span><span class="sub">→ ${approver}</span></td><td data-label="When"><time datetime="${htmlEscape(op.updatedAt)}" title="${htmlEscape(localStamp(op.updatedAt))}">${htmlEscape(when)}</time></td><td data-label="${actionLabel}" class="cell-action">${opAction(op)}</td></tr>`;
}
function opTable(ops: ControlOp[]) {
  return `<div class="table-wrap"><table class="ops"><thead><tr><th>State</th><th>Host</th><th>Command</th><th>Requested → approved</th><th>When</th><th>Action</th></tr></thead><tbody>${ops.map(opRow).join("")}</tbody></table></div>`;
}
function auditCard(audit: ControlAudit | undefined) {
  const ok = audit?.ok === true;
  // The head hash stays on one line on narrow screens.
  const detail = !audit
    ? htmlEscape("Audit status is unavailable.")
    : ok
      ? `${htmlEscape(`${audit.entries} entries · `)}<span class="nowrap">${htmlEscape(`head ${audit.head.slice(0, 4)}…${audit.head.slice(-4)}`)}</span>${audit.checkedAt ? ` · checked <span class="nowrap">${htmlEscape(localStamp(audit.checkedAt))}</span>` : ""}`
      : htmlEscape(
          `${audit.error ?? "Check failed"}. Preserve the files and investigate.`,
        );
  return `<section class="panel audit-card"><div><h2>Audit</h2><p><span class="badge ${ok ? "success" : "danger"}">${ok ? "Verified" : "Attention"}</span> <span class="muted">${detail}</span></p></div>${button("control-verify", "Verify now")}</section>`;
}
function queueSection(ops: ControlOp[]) {
  if (!ops.length)
    return `<div class="empty"><h2>No operations yet</h2><p>Plans appear here when an MCP client proposes a command with homectl_plan. Inspection plans are ready to run at once; changes wait for another client to approve.</p></div>`;
  const buckets: Record<ControlBucket, ControlOp[]> = {
    ready: [],
    needs: [],
    history: [],
  };
  for (const op of ops) buckets[bucketOf(op)].push(op);
  for (const list of Object.values(buckets))
    list.sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const tabs: [ControlBucket, string][] = [
    ["ready", "Ready to run"],
    ["needs", "Needs approval"],
    ["history", "History"],
  ];
  const buttons = tabs
    .map(
      ([id, label]) =>
        `<button type="button" class="${controlFilter === id ? "primary" : "quiet"}" aria-pressed="${controlFilter === id}" data-action="control-filter" data-id="${id}">${label} <span>${buckets[id].length}</span></button>`,
    )
    .join("");
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
  return `<div class="filter-tabs" role="group" aria-label="Filter operations">${buttons}</div>${note ? `<p class="inline-note">${htmlEscape(note)}</p>` : ""}${visible.length ? opTable(visible) : `<div class="empty"><p>${htmlEscape(empty)}</p></div>`}`;
}
function clientsSection(clients: ControlClient[]) {
  const command = `homectl control client add codex-pc --name "Codex PC" --scopes status:read,inspect:read,plan:create --hosts &lt;host&gt; --token-file &lt;path&gt;`;
  const intro = `<p class="muted">Clients are added in a private terminal, so the token file is written locally and never shown here. Copy this command and replace the placeholders:</p><pre>${command}</pre>`;
  if (!clients.length)
    return `<div class="empty"><h2>No clients yet</h2><p>Each MCP client gets its own identity, scopes and host grants. Add the first one from a terminal.</p></div>${intro}`;
  const rows = clients
    .map(
      (c) =>
        `<tr><td data-label="Client"><strong>${htmlEscape(c.name)}</strong><p><code>${htmlEscape(c.id)}</code></p>${c.oidc ? `<p><span class="badge" title="${htmlEscape(`${c.oidc.claim} hash ${c.oidc.identityHash}`)}">OIDC · ${htmlEscape(c.oidc.issuerHost)}</span></p>` : ""}</td><td data-label="Scopes"><div class="chips">${c.scopes.map((s) => `<span class="chip">${htmlEscape(s)}</span>`).join("")}</div></td><td data-label="Hosts"><div class="chips">${c.hosts.map((h) => `<span class="chip">${htmlEscape(h)}</span>`).join("")}</div></td><td data-label="Created"><time datetime="${htmlEscape(c.createdAt)}" title="${htmlEscape(localStamp(c.createdAt))}">${htmlEscape(localStamp(c.createdAt))}</time></td><td data-label="Status">${c.revoked ? `<span class="badge danger">revoked</span>` : `<span class="badge success">active</span>`}</td><td data-label="Action" class="cell-action">${c.revoked ? "" : button("control-revoke", "Revoke", c.id, "quiet danger")}</td></tr>`,
    )
    .join("");
  return `${intro}<div class="table-wrap"><table><thead><tr><th>Client</th><th>Scopes</th><th>Hosts</th><th>Created</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function resultBlock(title: string, text: string) {
  const body = text.trimEnd();
  if (!body.trim()) return "";
  const lines = body.split("\n").length;
  return `<details${lines <= 20 ? " open" : ""}><summary>${title} · ${lines} line${lines === 1 ? "" : "s"}</summary><pre>${htmlEscape(body)}</pre></details>`;
}
function executionResult(r: ControlExecution) {
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
  const body =
    !out.trim() && !err.trim()
      ? `<p class="muted">(no output)</p>`
      : `${resultBlock("stdout", out)}${resultBlock("stderr", err)}`;
  return `<section id="control-result" class="section panel" tabindex="-1" aria-labelledby="control-result-title"><div class="result-head"><h2 id="control-result-title">Execution result</h2><button type="button" class="quiet" aria-label="Close execution result" data-action="control-result-close">×</button></div><p><strong>${htmlEscape(headline)}</strong>${took ? ` <span class="muted">· took ${htmlEscape(took)}</span>` : ""}</p><p class="muted"><code>$ ${htmlEscape(shellArgv(op.argv))}</code></p>${body}</section>`;
}
// Owner-side picker: choose the receiving device, then confirm the offer.
function handoffPickerCard() {
  if (!handoffPicker) return "";
  const op = control?.operations.find((o) => o.operationId === handoffPicker);
  if (!op) return "";
  const devices = (control?.devices?.peers ?? []).filter((p) => !p.legacy);
  if (!devices.length)
    return `<section class="panel section"><h2>Hand off ${htmlEscape(op.host)}</h2><p class="muted">No paired device can take a handoff yet. Pair a device again so it has a signing key.</p><div class="form-actions">${button("control-handoff-close", "Close")}</div></section>`;
  return `<section class="panel section"><h2>Hand off ${htmlEscape(op.host)}</h2><p class="muted">The receiving device must accept. Until it does, this device keeps the operation and will not run it. You can cancel the offer before it is accepted.</p><div><label for="handoff-target">Receiving device</label><select id="handoff-target">${devices.map((d) => `<option value="${htmlEscape(d.id)}">${htmlEscape(d.name)}</option>`).join("")}</select></div><div class="form-actions">${button("control-handoff-close", "Close")}${button("control-handoff-go", "Continue…", op.operationId, "primary")}</div></section>`;
}
function approvals() {
  let content = heading(
    "Approvals",
    "Plans and runs from MCP clients. Approval comes from another client; this panel runs only what is already approved.",
  );
  content += auditCard(control?.audit);
  content += `<div class="filter-tabs" role="tablist" aria-label="Approvals sections"><button type="button" role="tab" aria-selected="${controlTab === "queue"}" class="${controlTab === "queue" ? "primary" : "quiet"}" data-action="control-tab" data-id="queue">Operations</button><button type="button" role="tab" aria-selected="${controlTab === "clients"}" class="${controlTab === "clients" ? "primary" : "quiet"}" data-action="control-tab" data-id="clients">Clients</button></div>`;
  content +=
    controlTab === "queue"
      ? queueSection(control?.operations ?? [])
      : clientsSection(control?.clients ?? []);
  content += handoffPickerCard();
  if (controlResult) content += executionResult(controlResult);
  return content;
}
function executionDetails(op: ControlOp) {
  return `<p><span class="badge ${op.classification === "destructive" ? "danger" : op.classification === "inspect" ? "" : "warning"}">${htmlEscape(op.classification)}</span> ${op.classification === "destructive" ? '<strong class="danger">This operation can delete or overwrite data.</strong>' : ""}</p><dl><dt>Host</dt><dd>${htmlEscape(op.host)}</dd><dt>Command</dt><dd><code>${htmlEscape(shellArgv(op.argv))}</code></dd><dt>Impact</dt><dd>${htmlEscape(op.impact || "—")}</dd><dt>Fingerprint</dt><dd><code>${htmlEscape(op.fingerprint)}</code></dd><dt>Approver</dt><dd>${htmlEscape(op.approval?.approver ?? "none needed (inspection)")}</dd></dl>`;
}
// Announces results to assistive technology through the persistent live region.
function announce(message: string) {
  element("control-live").textContent = message;
}
// Moves focus to the result card after a run so keyboard and screen-reader
// users land on the outcome.
function focusResult() {
  const card = document.getElementById("control-result");
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.focus({ preventScroll: true });
}

function output() {
  let html = "";
  if (operationResult)
    html += `<section class="section panel"><h2>Waiting for peer approval</h2><p class="muted">Open the execution device’s workspace, review the command, and approve it locally.</p>${button("operation-status", "Check result")}</section>`;
  if (remoteHosts)
    html += `<section class="section panel"><h2>Hosts on the paired device</h2>${remoteHosts.hosts.map((h) => `<div class="peer-row"><div><strong>${htmlEscape(h.name)}</strong><p>${htmlEscape(h.description)} · ${htmlEscape(h.access)}</p></div>${button("remote-command", "Command", h.name)}</div>`).join("")}</section>`;
  if (result !== undefined)
    html += `<section class="section panel"><h2>Operation result</h2><pre>${htmlEscape(typeof result === "string" ? result : JSON.stringify(result, null, 2))}</pre></section>`;
  return html;
}
async function confirm(title: string, description: string, html?: string) {
  const d = element<HTMLDialogElement>("confirm-dialog");
  // Remember the control that opened the dialog so focus can return to it.
  const returnTo =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  element("confirm-title").textContent = title;
  // Structured details are pre-escaped by the caller; plain text is never HTML.
  if (html !== undefined) element("confirm-description").innerHTML = html;
  else element("confirm-description").textContent = description;
  // showModal() traps focus, inerts the page, and closes on Escape (cancel).
  d.showModal();
  return new Promise<boolean>((resolve) => {
    d.addEventListener(
      "close",
      () => {
        resolve(d.returnValue === "confirm");
        // The opener is re-enabled when its task finishes; restore focus after that.
        setTimeout(() => {
          if (
            returnTo?.isConnected &&
            !(returnTo as HTMLButtonElement).disabled
          )
            returnTo.focus();
        }, 0);
      },
      { once: true },
    );
  });
}

function navigate(next: string) {
  view = next;
  // Banners describe the view that produced them; they do not follow the user.
  for (const id of ["error", "notice"]) element(id).hidden = true;
  editing = undefined;
  permissionPeer = undefined;
  commandHost = undefined;
  commandPeer = "";
  remoteHosts = undefined;
  result = undefined;
  location.hash = next;
  render();
}
element("connect-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void task(async () => {
    const input = element<HTMLInputElement>("token");
    const token = input.value;
    input.value = "";
    await api("/api/connect", { token });
    await refresh();
  });
});
document.addEventListener("click", (event) => {
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
  void task(async () => {
    switch (action) {
      case "add":
        editing = "";
        render();
        return;
      case "edit":
        editing = id;
        render();
        return;
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
      case "compare-conflict": {
        const section = document.querySelector<HTMLElement>(
          `[data-conflict="${Number(id)}"]`,
        );
        const comparison = section?.querySelector<HTMLElement>(".split");
        const retained = section?.querySelector<HTMLElement>(".retained");
        if (comparison) comparison.hidden = false;
        if (retained) retained.hidden = true;
        return;
      }
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
      case "pair-poll":
        await api("/api/pair/poll", {});
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
        preview = await api<Preview>("/api/sync/start", { id });
        view = "sync";
        render();
        return;
      case "sync-preview":
        preview = await api<Preview>("/api/sync/preview", { id });
        render();
        return;
      case "sync-cancel":
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
        if (!(await confirm(title, "", executionDetails(op)))) return;
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
        focusResult();
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
            `<dl><dt>Host</dt><dd>${htmlEscape(op.host)}</dd><dt>Command</dt><dd><code>${htmlEscape(shellArgv(op.argv))}</code></dd><dt>Current owner</dt><dd>${htmlEscape(owner)}</dd></dl>`,
          ))
        )
          return;
        await api("/api/control/handoff", { operationId: id });
        await refresh();
        announce(
          `Took over ${op.host}. It needs a fresh approval on this device.`,
        );
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
            `<dl><dt>Host</dt><dd>${htmlEscape(op.host)}</dd><dt>Command</dt><dd><code>${htmlEscape(shellArgv(op.argv))}</code></dd><dt>Receiving device</dt><dd>${htmlEscape(name)}</dd></dl>`,
          ))
        )
          return;
        await api("/api/control/handoff", {
          operationId: id,
          to: target.value,
        });
        handoffPicker = undefined;
        await refresh();
        announce(
          `Offered ${op.host} to ${name}. It applies when ${name} accepts.`,
        );
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
        announce(
          `Accepted ${op.host}. It needs a fresh approval on this device.`,
        );
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
        const answer = await api<{ accepted?: boolean }>(
          "/api/control/resolve",
          { operationId: id, owner },
        );
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
  });
});
element("refresh").addEventListener("click", () => void task(refresh));
element("lock").addEventListener(
  "click",
  () =>
    void task(async () => {
      await api("/api/vault/lock", {});
      await refresh();
    }),
);
document.addEventListener("input", (e) => {
  if ((e.target as HTMLElement).id === "filter") {
    const value = (e.target as HTMLInputElement).value.toLowerCase();
    document.querySelectorAll<HTMLElement>("[data-search]").forEach((row) => {
      row.hidden = !row.dataset.search?.includes(value);
    });
  }
});
document.addEventListener("change", (e) => {
  const radio = e.target as HTMLInputElement;
  if (!radio.name.startsWith("choice-") || !preview) return;
  const index = Number(radio.name.slice(7));
  const conflict = preview.conflicts[index];
  const section = radio.closest<HTMLElement>(".conflict");
  if (!conflict || !section) return;
  const comparison = section.querySelector<HTMLElement>(".split");
  if (comparison) comparison.hidden = true;
  let retained = section.querySelector<HTMLElement>(".retained");
  if (!retained) {
    retained = document.createElement("div");
    retained.className = "retained version";
    section.querySelector(".choice")?.before(retained);
  }
  const selected =
    radio.value === "remote" ? conflict.remote.value : conflict.local.value;
  retained.innerHTML = `<h3>${radio.value === "both" ? "Both versions kept" : "Selected version"}</h3><p class="muted">${radio.value === "both" ? "The received version will be copied to a new entry." : htmlEscape(radio.value === "remote" ? preview.remoteName : preview.localName)}</p><pre>${htmlEscape(JSON.stringify(selected, null, 2))}</pre>${button("compare-conflict", "Compare again", String(index), "quiet")}`;
  retained.hidden = false;
  retained.setAttribute("role", "status");
  section.classList.add("resolved");
});
document.addEventListener("submit", (e) => {
  const form = e.target as HTMLFormElement;
  if (form.id === "connect-form" || !form.id) return;
  e.preventDefault();
  const values = new FormData(form);
  void task(async () => {
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
      const argv = JSON.parse(String(values.get("argv")));
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
          `${JSON.stringify(argv)} · ${plan.plan.classification} · ${impact}`,
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
    }
    if (form.id === "unlock-form") {
      const password = String(values.get("password"));
      element<HTMLInputElement>("password").value = "";
      await api("/api/vault/unlock", {
        password,
        create: values.has("create"),
      });
    }
    if (form.id === "settings-form")
      await api("/api/settings", {
        name: values.get("name"),
        ttl: values.get("ttl"),
      });
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
    report("Changes saved.", "notice");
  });
});
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
    element("connection").hidden = false;
    element("workspace").hidden = true;
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
  if (state) render();
}
void boot();
