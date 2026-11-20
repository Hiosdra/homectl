import type { MigrationResult } from "../migrate/types";
import { HomectlError } from "../types";

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
function formatDateTime(value: unknown): string {
  const timestamp = Number(value);
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime()))
    return scalar(value);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}
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
// The Dependencies block of a setup or update result. Nothing missing reads as
// "All found" (a dry run reports { missing: [] }); missing tools are named; a
// list of checks or planned actions is shown as before.
function dependencySection(dependencies: Record<string, unknown>): string {
  const detail = dependencies.checks ?? dependencies.actions;
  if (detail !== undefined && !(Array.isArray(detail) && detail.length === 0))
    return `Dependencies\n${checks(detail)}`;
  const missing = Array.isArray(dependencies.missing)
    ? dependencies.missing
    : [];
  return missing.length > 0
    ? `Dependencies\nMissing: ${missing.map(String).join(", ")}`
    : "Dependencies\nAll found";
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
// `migrate` results: the plan of a dry run, or what a run did. Shows the steps
// and the files each may touch, the backup taken, and the notes for the owner.
export function formatMigration(result: MigrationResult): string {
  switch (result.status) {
    case "current":
      return `Data version ${result.version} is current. Nothing to migrate.`;
    case "initialized":
      return `No 0.2 data was found. Created an empty workspace at data version ${result.version}.`;
    case "planned": {
      if (result.steps.length === 0)
        return `Dry run: nothing to migrate. A run would only record data version ${result.to}. Nothing was changed.`;
      const steps = result.steps.flatMap((step, index) => [
        `${index + 1}. ${step.description} (${step.id})`,
        `   May touch: ${step.touches.length ? step.touches.join(", ") : "nothing"}`,
      ]);
      return [
        `Dry run: data version ${result.from} would migrate to ${result.to} in ${result.steps.length} step(s). Nothing was changed.`,
        steps.join("\n"),
      ].join("\n\n");
    }
    case "migrated": {
      const lines = [
        `Migrated data version ${result.from} to ${result.to}.`,
        `Backup: ${result.backup}`,
        `Steps: ${result.steps.join(", ") || "none"}`,
      ];
      if (result.notes.length)
        lines.push("", "Notes:", ...result.notes.map((note) => `• ${note}`));
      return lines.join("\n");
    }
  }
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
      : "No paired devices. Run home-ctl pair on both computers.";
  if (command === "commands" && action === "list" && Array.isArray(value))
    return value.length
      ? tree(value)
      : "No saved commands yet. Use home-ctl commands save --file PATH.";
  if (!record(value)) return tree(value);
  if (command === "migrate" && typeof value.status === "string")
    return formatMigration(value as unknown as MigrationResult);
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
  if (command === "update" && Array.isArray(value.actions)) {
    const preview = value.revision === undefined;
    return [
      preview
        ? "Update preview"
        : value.updated
          ? "Updated successfully."
          : "Already up to date.",
      typeof value.revision === "string"
        ? `Version: ${value.revision.slice(0, 7)}`
        : "",
      value.actions.map((item) => `${preview ? "•" : "✓"} ${item}`).join("\n"),
      value.updated && value.next ? String(value.next) : "",
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
    if (record(dependencies)) sections.push(dependencySection(dependencies));
    if (doctor) sections.push(formatHuman(doctor, "doctor"));
    if (next) sections.push(String(next));
    if (hint) sections.push(String(hint));
    return sections.filter(Boolean).join("\n\n");
  }
  if (command === "session" && action === "status") {
    const { unlocked, startedAt, expiresAt, ...rest } = value;
    return [
      `Session: ${unlocked ? "unlocked" : "locked"}`,
      startedAt !== undefined ? `Started At: ${formatDateTime(startedAt)}` : "",
      expiresAt !== undefined
        ? `Expires: ${expiresAt === null ? "until reboot or explicit lock" : formatDateTime(expiresAt)}`
        : "",
      tree(rest),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (command === "session") {
    return tree(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === "startedAt"
            ? formatDateTime(item)
            : key === "expiresAt"
              ? item === null
                ? "until reboot or explicit lock"
                : formatDateTime(item)
              : item,
        ]),
      ),
    );
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

export function normalizeCliError(error: unknown): HomectlError {
  if (error instanceof HomectlError) return error;
  if (error instanceof Error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code?.startsWith("ERR_PARSE_ARGS_"))
      return new HomectlError(2, error.message);
    if (failure.code === "ENOENT" && typeof failure.path === "string")
      return new HomectlError(2, `Cannot read file ${failure.path}`);
  }
  return new HomectlError(
    2,
    "Invalid input or unavailable resource; details suppressed",
  );
}
