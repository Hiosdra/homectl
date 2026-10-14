type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
const scalar = (value: unknown) =>
  value === null
    ? "None"
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : String(value);
function tree(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value))
    return value.length
      ? value
          .map((item) =>
            record(item)
              ? `${indent}•\n${tree(item, depth + 1)}`
              : `${indent}• ${scalar(item)}`,
          )
          .join("\n")
      : `${indent}None`;
  if (!record(value)) return `${indent}${scalar(value)}`;
  return Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([key, item]) => {
      if (record(item) || Array.isArray(item))
        return `${indent}${label(key)}:\n${tree(item, depth + 1)}`;
      return `${indent}${label(key)}: ${scalar(item)}`;
    })
    .join("\n");
}
function checks(value: unknown): string {
  if (!Array.isArray(value)) return tree(value);
  return value
    .map((check) =>
      record(check)
        ? `${check.ok ? "OK" : "FAIL"}  ${check.name}${check.remediation ? `\n      ${check.remediation}` : ""}`
        : scalar(check),
    )
    .join("\n");
}
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
export function formatHuman(
  value: unknown,
  command?: string,
  action?: string,
): string {
  if (typeof value === "string") return value;
  if (command === "hosts" && record(value)) {
    const rows = Object.entries(value).map(([name, m]) => [
      name,
      record(m) ? String(m.address ?? "local") : "",
      record(m) ? String(m.access ?? "") : "",
      record(m) ? String(m.description ?? "") : "",
    ]);
    return rows.length
      ? table(["Machine", "Address", "Access", "Description"], rows)
      : "No machines configured.";
  }
  if (command === "peers" && Array.isArray(value))
    return value.length
      ? table(
          ["Device", "ID", "Address"],
          value.map((peer) =>
            record(peer)
              ? [
                  String(peer.name ?? ""),
                  String(peer.id ?? ""),
                  String(peer.address ?? ""),
                ]
              : [scalar(peer), "", ""],
          ),
        )
      : "No paired devices. Run homectl pair on both computers.";
  if (!record(value)) return tree(value);
  if (command === "doctor" && Array.isArray(value.checks)) {
    const { checks: entries, ok, note, ...rest } = value;
    return [
      ok ? "Doctor: all checks passed." : "Doctor: action required.",
      checks(entries),
      Object.keys(rest).length ? tree(rest) : "",
      note,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (command === "setup" || command === "update") {
    const { actions, next, dependencies, doctor, hint, ...rest } = value;
    const sections = [
      command === "setup"
        ? "Setup"
        : value.updated === false
          ? "Already up to date."
          : "Update",
      Object.keys(rest).length ? tree(rest) : "",
      Array.isArray(actions)
        ? actions.map((item) => `• ${item}`).join("\n")
        : "",
    ];
    if (record(dependencies))
      sections.push(
        `Dependencies\n${checks(dependencies.checks ?? dependencies.actions)}`,
      );
    if (doctor) sections.push(formatHuman(doctor, "doctor"));
    if (next) sections.push(String(next));
    if (hint) sections.push(String(hint));
    return sections.filter(Boolean).join("\n\n");
  }
  if (command === "session" && action === "status") {
    const { unlocked, expiresAt, ...rest } = value;
    return [
      `Session: ${unlocked ? "unlocked" : "locked"}`,
      expiresAt !== undefined
        ? `Expires: ${expiresAt === null ? "until reboot or explicit lock" : new Date(Number(expiresAt)).toISOString()}`
        : "",
      tree(rest),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if ((command === "exec" || command === "peer") && record(value.result)) {
    const { stdout, stderr, exitCode, ...rest } = value.result;
    const lines = [
      stdout ? String(stdout).trimEnd() : "",
      stderr ? `Error output:\n${String(stderr).trimEnd()}` : "",
      `Exit code: ${exitCode ?? "unknown"}`,
    ];
    if (Object.keys(rest).length) lines.push(tree(rest));
    return lines.filter(Boolean).join("\n");
  }
  return tree(value);
}
export function formatError(
  message: string,
  code: number,
  details?: unknown,
): string {
  return `Error: ${message}\nExit code: ${code}${details ? `\n${tree(details)}` : ""}`;
}
