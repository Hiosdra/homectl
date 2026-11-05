// Human-readable rendering for the control plane: CLI tables, detail views,
// execution summaries and short MCP tool summaries. JSON output never goes
// through this module.
import type { ClientView, OperationView } from "./types";

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

function stateStyle(label: string): Style {
  switch (label) {
    case "pending":
      return "yellow";
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
  const rows = operations.map((op) => {
    const label = stateLabel(op);
    const when =
      op.state === "pending" || op.state === "approved"
        ? expiryLabel(op.expiresAt, options.now)
        : relativeTime(op.updatedAt, options.now);
    return [
      shortId(op.operationId),
      paint(label, stateStyle(label), options.color),
      op.host,
      op.classification,
      displayArgv(op.argv, 40),
      op.issuer,
      op.approval?.approver ?? (op.needsApproval ? "—" : "not needed"),
      when,
    ];
  });
  return table(headers, rows);
}

export function renderOperationDetail(
  op: OperationView,
  options: { color: boolean; now: number },
): string {
  const label = stateLabel(op);
  const lines: [string, string][] = [
    ["Operation", op.operationId],
    ["State", paint(label, stateStyle(label), options.color)],
    ["Host", op.host],
    ["Classification", op.classification],
    ["Command", displayArgv(op.argv, 200)],
    ["Impact", op.impact || "—"],
    ["Fingerprint", op.fingerprint],
    ["Issuer", op.issuer],
    [
      "Approver",
      op.approval?.approver ?? (op.needsApproval ? "none yet" : "not needed"),
    ],
    [
      "Created",
      `${localTime(op.createdAt)} (${relativeTime(op.createdAt, options.now)})`,
    ],
    ["Expiry", expiryLabel(op.expiresAt, options.now)],
  ];
  if (op.exitCode !== undefined) lines.push(["Exit code", String(op.exitCode)]);
  if (op.reason !== undefined) lines.push(["Reason", op.reason]);
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
  const lines = [`${head} · ${who}`, `  $ ${displayArgv(op.argv, 200)}`];
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

// Short sentence for an agent reading a tool result. Carries the full
// operation id and fingerprint so an approver can act on the text alone.
export function summarizeTool(
  tool: string,
  value: unknown,
  now: number,
): string {
  const v = value as Partial<OperationView> & {
    operation?: OperationView;
    approval?: { approver: string; expiresAt: string };
    operations?: OperationView[];
    hosts?: { host: string; access: string; description: string }[];
    client?: { id: string };
  };
  if (tool === "homectl_plan" && v.operationId) {
    const approval = v.needsApproval
      ? "needs approval by another client"
      : "no approval needed";
    const next = v.needsApproval
      ? "Ask a different authorized client to approve it with homectl_approve."
      : `The local operator can run it with: homectl control execute ${v.operationId}`;
    return `Planned ${shortId(v.operationId)} on ${v.host}: \`${displayArgv(v.argv ?? [], 120)}\` (${v.classification}, ${approval}). Operation ${v.operationId}. Fingerprint ${v.fingerprint}. Expires ${clockTime(v.expiresAt ?? new Date(now).toISOString())}. ${next}`;
  }
  if (tool === "homectl_approve" && v.operation) {
    const op = v.operation;
    if (v.approval)
      return `Approved ${shortId(op.operationId)} on ${op.host} by ${v.approval.approver}. Operation ${op.operationId}. Approval expires ${clockTime(v.approval.expiresAt)}. The local operator can now run it.`;
    return `Rejected ${shortId(op.operationId)} on ${op.host}; it will not run. Operation ${op.operationId}.`;
  }
  if (tool === "homectl_status") {
    if (v.operationId)
      return `Operation ${shortId(v.operationId)} on ${v.host}: ${stateLabel(v as OperationView)}${v.reason ? ` (${v.reason})` : ""}. Operation ${v.operationId}. Fingerprint ${v.fingerprint}.`;
    const list = v.operations ?? [];
    if (list.length === 0) return "No operations visible to this client yet.";
    return `${list.length} operation(s) on your granted hosts; most recent ${shortId(list[0]?.operationId ?? "")} is ${stateLabel(list[0] ?? { state: "pending" })} on ${list[0]?.host}.`;
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
