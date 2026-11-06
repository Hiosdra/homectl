// Human-readable rendering for the control plane: CLI tables, detail views,
// execution summaries and short MCP tool summaries. JSON output never goes
// through this module.
import type { ClientIdentity, ClientView, OperationView } from "./types";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const STYLES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
} as const;
export type Style = keyof typeof STYLES;

// Color only for an interactive terminal, and never when NO_COLOR is set.
export function colorEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    Boolean(stream.isTTY) && env.NO_COLOR === undefined && env.TERM !== "dumb"
  );
}

export function paint(text: string, style: Style, enabled: boolean): string {
  if (!enabled) return text;
  const [open, close] = STYLES[style];
  return `${ESC}[${open}m${text}${ESC}[${close}m`;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// Local wall-clock time, "2026-11-05 21:55:40".
export function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Local clock time, "21:55" (used in short agent-facing summaries).
export function clockTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function span(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return "<1 min";
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} h`;
  return `${Math.round(abs / 86_400_000)} d`;
}

export function relativeTime(iso: string, now: number): string {
  const delta = Date.parse(iso) - now;
  return delta >= 0 ? `in ${span(delta)}` : `${span(delta)} ago`;
}

export function expiryLabel(iso: string, now: number): string {
  const delta = Date.parse(iso) - now;
  return delta >= 0
    ? `expires in ${span(delta)}`
    : `expired ${span(delta)} ago`;
}

// "840 ms", "3.2 s", "2 min 5 s".
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const total = Math.round(ms / 1_000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

export function durationOf(
  op: Pick<OperationView, "startedAt" | "finishedAt">,
): string | undefined {
  if (!op.startedAt || !op.finishedAt) return undefined;
  return formatDuration(Date.parse(op.finishedAt) - Date.parse(op.startedAt));
}

// Shell-style quoting for display only. Never executed.
export function displayArgv(argv: string[], max = 72): string {
  const text = argv
    .map((arg) =>
      /^[A-Za-z0-9_/.:=@%+,-]+$/.test(arg)
        ? arg
        : `'${arg.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(
      stripAnsi(header).length,
      ...rows.map((row) => stripAnsi(row[i] ?? "").length),
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map(
        (cell, i) =>
          cell + " ".repeat((widths[i] ?? 0) - stripAnsi(cell).length),
      )
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

// "expired" is shown for plans and approvals closed by expiry, not for
// operations that failed while running.
export function stateLabel(
  op: Pick<OperationView, "state" | "reason">,
): string {
  if (
    op.state === "failed" &&
    (op.reason === "plan-expired" || op.reason === "approval-expired")
  )
    return "expired";
  return op.state;
}

// What a person should understand at a glance. The stored state stays
// `pending` for inspection plans; only the presentation says "ready".
export function displayState(
  op: Pick<OperationView, "state" | "reason" | "needsApproval">,
): string {
  const label = stateLabel(op);
  if (label === "expired") return "expired";
  if (op.state === "pending")
    return op.needsApproval ? "needs approval" : "ready";
  if (op.state === "approved") return "ready";
  return op.state;
}

function stateStyle(label: string): Style {
  switch (label) {
    case "needs approval":
      return "yellow";
    case "ready":
    case "approved":
    case "executing":
      return "cyan";
    case "succeeded":
      return "green";
    case "failed":
    case "unknown":
      return "red";
    default:
      return "dim";
  }
}

// Ready items first, then items needing approval, then running, then history.
function rank(op: Pick<OperationView, "state" | "needsApproval" | "reason">) {
  const label = displayState(op);
  if (label === "ready") return 0;
  if (label === "needs approval") return 1;
  if (label === "executing") return 2;
  return 3;
}

function approverText(
  op: Pick<
    OperationView,
    "approval" | "needsApproval" | "approvedBy" | "delivery"
  >,
): string {
  if (op.approval) return op.approval.approver;
  if (op.approvedBy) return op.approvedBy;
  if (op.delivery?.status === "awaiting-confirmation")
    return `forwarded to ${op.delivery.ownerName}, awaiting confirmation`;
  return op.needsApproval ? "awaiting approval" : "not needed";
}

// One line on who holds an operation and where a forwarded approval stands.
export function replicaNote(
  op: Pick<
    OperationView,
    "runsOn" | "delivery" | "approvedBy" | "conflict" | "ownerName"
  >,
): string | undefined {
  if (op.delivery?.status === "awaiting-confirmation")
    return `approval forwarded to ${op.delivery.ownerName}, awaiting confirmation`;
  if (op.delivery?.status === "rejected")
    return `rejection confirmed by ${op.delivery.ownerName}`;
  if (op.approvedBy) return `approved by ${op.approvedBy}`;
  if (op.conflict) return "no owner: conflicting takeovers need an operator";
  if (op.runsOn) return `runs on ${op.runsOn}`;
  return undefined;
}

function scopesText(scopes: string[]): string {
  return scopes.join(", ");
}

export function renderClients(
  clients: ClientView[],
  options: { color: boolean },
): string {
  if (clients.length === 0)
    return "No clients yet. Create one with: homectl control client add <id> --name NAME --scopes LIST --hosts LIST --token-file PATH";
  const ordered = [...clients].sort(
    (a, b) => Number(a.revoked) - Number(b.revoked) || a.id.localeCompare(b.id),
  );
  const headers = ["ID", "NAME", "SCOPES", "HOSTS", "CREATED", "STATUS"].map(
    (h) => paint(h, "bold", options.color),
  );
  const rows = ordered.map((c) => {
    const status = c.revoked
      ? paint("revoked", "dim", options.color)
      : paint("active", "green", options.color);
    const cells = [
      c.id,
      c.name,
      scopesText(c.scopes),
      c.hosts.join(", "),
      localTime(c.createdAt),
      status,
    ];
    return c.revoked
      ? cells.map((cell) => paint(stripAnsi(cell), "dim", options.color))
      : cells;
  });
  return table(headers, rows);
}

export function renderOperations(
  operations: OperationView[],
  options: { color: boolean; now: number },
): string {
  if (operations.length === 0)
    return "No operations match. Plan one from an MCP client (homectl_plan), or use --all to include history.";
  const ordered = [...operations].sort(
    (a, b) =>
      rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const headers = [
    "ID",
    "STATE",
    "HOST",
    "CLASS",
    "ARGV",
    "ISSUER",
    "APPROVER",
    "WHEN",
  ].map((h) => paint(h, "bold", options.color));
  const rows = ordered.map((op) => {
    const label = displayState(op);
    const when =
      op.state === "pending" || op.state === "approved"
        ? expiryLabel(op.expiresAt, options.now)
        : relativeTime(op.updatedAt, options.now);
    return [
      shortId(op.operationId),
      paint(label, stateStyle(label), options.color),
      op.runsOn ? `${op.host} · runs on ${op.runsOn}` : op.host,
      op.classification,
      displayArgv(op.argv, 40),
      op.issuer,
      approverText(op),
      when,
    ];
  });
  return table(headers, rows);
}

export function renderOperationDetail(
  op: OperationView,
  options: { color: boolean; now: number },
): string {
  const label = displayState(op);
  const open = op.state === "pending" || op.state === "approved";
  const lines: [string, string][] = [
    ["Operation", op.operationId],
    ["State", paint(label, stateStyle(label), options.color)],
    ["Host", op.host],
    ["Classification", op.classification],
    ["Command", displayArgv(op.argv, 200)],
    ["Impact", op.impact || "—"],
    ["Fingerprint", op.fingerprint],
    ["Issuer", op.issuer],
    ["Approver", approverText(op)],
    [
      "Created",
      `${localTime(op.createdAt)} (${relativeTime(op.createdAt, options.now)})`,
    ],
  ];
  if (op.startedAt) {
    lines.push([
      "Executed",
      `${localTime(op.startedAt)} (${relativeTime(op.startedAt, options.now)})`,
    ]);
    lines.push(["Duration", durationOf(op) ?? "still running"]);
  }
  if (op.ownerName !== undefined) lines.push(["Owner", op.ownerName]);
  if (op.offerTo !== undefined)
    lines.push([
      "Offer",
      `to ${op.offerTo}${op.offerExpires ? `, offer ${expiryLabel(op.offerExpires, options.now)}` : ""}`,
    ]);
  if (op.takeover)
    lines.push([
      "Takeover",
      op.takeover.possible
        ? "possible now (operator action: homectl control handoff)"
        : `${op.takeover.reason ?? "not possible"}${op.takeover.at ? ` (${localTime(op.takeover.at)})` : ""}`,
    ]);
  const note = replicaNote(op);
  if (note !== undefined && (op.delivery || op.approvedBy || op.conflict))
    lines.push(["Replication", note]);
  if (op.exitCode !== undefined) lines.push(["Exit code", String(op.exitCode)]);
  if (op.reason !== undefined) lines.push(["Reason", op.reason]);
  if (open) {
    // Plan expiry while waiting; approval expiry once approved.
    const approved = op.state === "approved" && op.approval;
    lines.push([
      approved ? "Approval" : "Plan",
      expiryLabel(
        approved ? (op.approval?.expiresAt ?? op.expiresAt) : op.expiresAt,
        options.now,
      ),
    ]);
  } else if (!op.startedAt) {
    // Legacy terminal records have no start time; only a closure that never
    // spawned is "never executed".
    lines.push(
      op.spawnAttempted || op.exitCode !== undefined || op.state === "succeeded"
        ? ["Finished", localTime(op.updatedAt)]
        : ["Closed", `${localTime(op.updatedAt)} (never executed)`],
    );
  }
  const width = Math.max(...lines.map(([k]) => k.length));
  return lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

export function renderExecution(
  result: {
    operation: OperationView;
    output?: { stdout: string; stderr: string };
  },
  options: { color: boolean },
): string {
  const { operation: op, output } = result;
  const who = op.approval
    ? `approved by ${op.approval.approver}`
    : "no approval needed";
  const took = durationOf(op);
  let head: string;
  if (op.state === "succeeded")
    head = paint(
      `✓ succeeded on ${op.host} (exit ${op.exitCode ?? 0})`,
      "green",
      options.color,
    );
  else if (op.state === "failed" && op.exitCode !== undefined)
    head = paint(`✗ failed (exit ${op.exitCode})`, "red", options.color);
  else if (op.state === "failed")
    head = paint(
      `✗ failed${op.reason ? ` (${op.reason})` : ""}`,
      "red",
      options.color,
    );
  else
    head = paint(
      `? ${op.state} on ${op.host}; the outcome is uncertain. Inspect the audit journal; it is not retried`,
      "red",
      options.color,
    );
  const lines = [
    `${head} · ${who}${took ? ` · took ${took}` : ""}`,
    `  $ ${displayArgv(op.argv, 200)}`,
  ];
  const stdout = output?.stdout ?? "";
  const stderr = output?.stderr ?? "";
  if (!stdout.trim() && !stderr.trim()) {
    lines.push("  (no output)");
  } else {
    if (stdout.trim()) lines.push("  stdout:", ...indent(stdout.trimEnd()));
    if (stderr.trim()) lines.push("  stderr:", ...indent(stderr.trimEnd()));
  }
  return lines.join("\n");
}

function indent(text: string): string[] {
  return text.split("\n").map((line) => `    ${line}`);
}

export function renderAudit(
  check: {
    ok: boolean;
    entries: number;
    head: string;
    error?: string;
  },
  options: { color: boolean },
): string {
  if (check.ok)
    return `${paint("Audit chain verified", "green", options.color)} · ${check.entries} entries · head ${check.head.slice(0, 4)}…${check.head.slice(-4)}`;
  return `${paint("Audit verification failed", "red", options.color)}: ${check.error ?? "unknown"}. Preserve the files and investigate.`;
}

export interface SyncRow {
  id?: string;
  name: string;
  lastSync?: number;
  leaseOk: boolean;
  // A legacy peer without a signing key: excluded from the lease.
  excluded?: boolean;
  // Suspended from this device's lease by this device.
  suspended?: { by: string; at: string; reason?: string };
  refused?: string;
  failures?: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export interface SyncView {
  live: boolean;
  disabledBy?: string;
  peers: SyncRow[];
  conflicts: { opId: string; epoch: number; candidates: string[] }[];
  resolutions?: {
    opId: string;
    conflictEpoch: number;
    winner: string;
    resolver: string;
  }[];
  blocked: Record<string, string>;
  // Device id to display name; ids are shown when a name is unknown.
  names?: Record<string, string>;
}

// Per-peer control sync status. Backoff is known only from a running serve;
// the saved-state view says so instead of guessing. Excluded (legacy) peers
// show dashes: they have no control sync, so there is no lease or backoff.
export function renderSync(
  view: SyncView,
  options: { color: boolean; now: number },
): string {
  const name = (id: string) => view.names?.[id] ?? id;
  if (view.disabledBy) {
    return `Control sync is disabled by ${view.disabledBy} on this device. Operations that have paired peers wait for a sync.`;
  }
  const lines = [
    view.live
      ? "Control sync: running on this device."
      : "serve not running — showing last saved state; backoff unknown.",
  ];
  if (view.peers.length === 0) {
    lines.push("No paired devices take part in control sync yet.");
  } else {
    const headers = ["DEVICE", "LAST SYNC", "LEASE", "BACKOFF", "STATUS"].map(
      (h) => paint(h, "bold", options.color),
    );
    const rows = view.peers.map((peer) => {
      if (peer.suspended)
        return [
          peer.name,
          peer.lastSync === undefined
            ? "never"
            : relativeTime(new Date(peer.lastSync).toISOString(), options.now),
          `suspended by ${peer.suspended.by} at ${clockTime(peer.suspended.at)}`,
          "—",
          "not counted in the lease",
        ];
      if (peer.excluded)
        return [
          peer.name,
          "never (control)",
          "excluded from lease: re-pair required",
          "—",
          peer.refused ?? "—",
        ];
      const backoff = !view.live
        ? "unknown"
        : peer.nextAttemptAt !== undefined &&
            (peer.failures ?? 0) > 0 &&
            peer.nextAttemptAt > options.now
          ? `retry ${clockTime(new Date(peer.nextAttemptAt).toISOString())}`
          : "none";
      return [
        peer.name,
        peer.lastSync === undefined
          ? "never"
          : relativeTime(new Date(peer.lastSync).toISOString(), options.now),
        peer.leaseOk ? "ok" : "expired: waiting for sync",
        backoff,
        peer.refused ?? peer.lastError ?? "ok",
      ];
    });
    lines.push(table(headers, rows));
  }
  if (view.conflicts.length === 0) {
    lines.push("Control conflicts: none.");
  } else {
    lines.push(
      `Control conflicts: ${view.conflicts.length}. These operations have no owner and cannot run until an operator resolves them.`,
    );
    for (const c of view.conflicts)
      lines.push(
        `  ${shortId(c.opId)}: two different handoffs at epoch ${c.epoch} (${c.candidates.map(name).join(", ")}).`,
      );
  }
  for (const r of view.resolutions ?? [])
    lines.push(
      `  Resolution for ${shortId(r.opId)} proposed by ${name(r.resolver)} names ${name(r.winner)}; it applies once ${name(r.winner)} runs control resolve on its device.`,
    );
  for (const [origin, reason] of Object.entries(view.blocked))
    lines.push(`Blocked log from ${name(origin)}: ${reason}`);
  return lines.join("\n");
}

export function mcpSnippet(name: string, url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [name]: {
          type: "http",
          url,
          headers: { Authorization: "Bearer <contents of the token file>" },
        },
      },
    },
    null,
    2,
  );
}

// An operation this caller may approve right now: pending, needs approval,
// not expired, and issued by someone else. Host grants are already enforced
// by the list that is passed in.
export function awaitingApprovalBy(
  op: Pick<
    OperationView,
    "state" | "needsApproval" | "expired" | "issuer" | "delivery"
  >,
  caller: Pick<ClientIdentity, "id" | "scopes"> | undefined,
): boolean {
  return Boolean(
    caller?.scopes.includes("approve:decide") &&
      op.state === "pending" &&
      op.needsApproval &&
      !op.expired &&
      op.issuer !== caller.id &&
      // A forwarded approval is already on its way to the owner.
      op.delivery?.status !== "awaiting-confirmation",
  );
}

// Short sentence for an agent reading a tool result. Carries the full
// operation id and fingerprint so an approver can act on the text alone.
export function summarizeTool(
  tool: string,
  value: unknown,
  now: number,
  caller?: Pick<ClientIdentity, "id" | "scopes">,
): string {
  const v = value as Partial<OperationView> & {
    operation?: OperationView;
    operationId?: string;
    forwarded?: { ownerName: string; lastSync?: number };
    approval?: { approver: string; expiresAt: string };
    operations?: OperationView[];
    hosts?: { host: string; access: string; description: string }[];
    client?: { id: string };
  };
  const run = (id: string) =>
    `The local operator can run it: homectl control execute ${id} (or Execute in the panel → Approvals).`;
  if (tool === "homectl_plan" && v.operationId) {
    const approval = v.needsApproval
      ? "needs approval by another client"
      : "ready to run, no approval needed";
    const next = v.needsApproval
      ? "Ask a different authorized client to approve it with homectl_approve, using the operation id and fingerprint above."
      : run(v.operationId);
    return `Planned ${shortId(v.operationId)} on ${v.host}: \`${displayArgv(v.argv ?? [], 120)}\` (${v.classification}, ${approval}). Operation ${v.operationId}. Fingerprint ${v.fingerprint}. Expires ${clockTime(v.expiresAt ?? new Date(now).toISOString())}. ${next}`;
  }
  if (tool === "homectl_approve" && v.forwarded) {
    const f = v.forwarded;
    const last = f.lastSync
      ? relativeTime(new Date(f.lastSync).toISOString(), now)
      : "never";
    return `Approval forwarded to owner ${f.ownerName}; it applies after the next sync (last sync ${last}). Operation ${v.operationId ?? ""}.`;
  }
  if (tool === "homectl_approve" && v.operation) {
    const op = v.operation;
    if (v.approval)
      return `Approved ${shortId(op.operationId)} on ${op.host} by ${v.approval.approver}. Operation ${op.operationId}. Approval expires ${clockTime(v.approval.expiresAt)}. ${run(op.operationId)}`;
    return `Rejected ${shortId(op.operationId)} on ${op.host}; it will not run. Operation ${op.operationId}.`;
  }
  if (tool === "homectl_status") {
    if (v.operationId) {
      const hint = awaitingApprovalBy(v as OperationView, caller)
        ? " You can approve it with homectl_approve, using the operation id and fingerprint above."
        : "";
      const runs = v.runsOn ? ` (runs on ${v.runsOn})` : "";
      const note = replicaNote(v as OperationView);
      return `Operation ${shortId(v.operationId)} on ${v.host}${runs}: ${displayState(v as OperationView)}${v.reason ? ` (${v.reason})` : ""}. Operation ${v.operationId}. Fingerprint ${v.fingerprint}.${note ? ` ${note[0]?.toUpperCase()}${note.slice(1)}.` : ""}${hint}`;
    }
    const list = [...(v.operations ?? [])].sort((a, b) => rank(a) - rank(b));
    if (list.length === 0) return "No operations visible to this client yet.";
    const shown = list.slice(0, 10);
    const lines = [
      `${list.length} operation(s) on your granted hosts${list.length > shown.length ? `, showing ${shown.length}` : ""}:`,
    ];
    for (const op of shown) {
      lines.push(
        `- ${shortId(op.operationId)} ${displayState(op)} · ${op.host} · \`${displayArgv(op.argv, 60)}\`${op.runsOn ? ` · runs on ${op.runsOn}` : ""}`,
      );
      const note = replicaNote(op);
      if (note !== undefined && (op.delivery || op.approvedBy || op.conflict))
        lines.push(`  ${note[0]?.toUpperCase()}${note.slice(1)}.`);
      if (awaitingApprovalBy(op, caller))
        lines.push(
          `  Approve with homectl_approve: operationId ${op.operationId}, fingerprint ${op.fingerprint}`,
        );
    }
    return lines.join("\n");
  }
  if (tool === "homectl_inspect") {
    if (v.hosts)
      return v.hosts.length
        ? `Granted hosts: ${v.hosts.map((h) => h.host).join(", ")}.`
        : "No hosts are granted to this client.";
    const host = v as unknown as {
      host: string;
      access: string;
      transport: string;
      description: string;
    };
    return `${host.host}: ${host.access} tier, ${host.transport} transport. ${host.description}`;
  }
  return "Done.";
}
