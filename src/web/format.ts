// Pure formatting and classification helpers for the panel. No DOM or module state.
import type { ControlOp, Preview } from "./types";
export function displayArgv(argv: string[]) {
  return argv.map((arg) => JSON.stringify(arg)).join(" ");
}
export const sessionTtlPresets = [
  ["1h", "1 hour"],
  ["12h", "12 hours"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["until-reboot", "Until this computer restarts"],
] as const;
export function sessionTtlLabel(value: string) {
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

export function accessLabel(value: string) {
  return (
    {
      observe: "Read-only",
      user: "Standard user",
      "sudo-approved": "Approved admin commands",
      full: "Full account access",
    }[value] ?? value
  );
}
export function formatLocalDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
export type ControlBucket = "ready" | "needs" | "history";
export function isReady(op: ControlOp) {
  return (
    op.state === "approved" || (op.state === "pending" && !op.needsApproval)
  );
}
export function bucketOf(op: ControlOp): ControlBucket {
  if (isReady(op)) return "ready";
  if (op.state === "pending") return "needs";
  return "history";
}
export function rankOf(op: ControlOp) {
  const bucket = bucketOf(op);
  if (bucket === "ready") return 0;
  if (bucket === "needs") return 1;
  return op.state === "executing" ? 2 : 3;
}
export function labelOf(op: ControlOp) {
  if (op.state !== "failed") return op.state;
  if (op.reason === "plan-expired" || op.reason === "approval-expired")
    return "expired";
  // A request the owner closed from this panel is stored as failed with reason denied.
  return op.reason === "denied" ? "denied" : op.state;
}
// What a person should read at a glance; the stored state is unchanged.
export function displayStateOf(op: ControlOp) {
  const label = labelOf(op);
  if (label === "expired") return "expired";
  if (op.state === "pending")
    return op.needsApproval ? "needs approval" : "ready";
  if (op.state === "approved") return "ready";
  return label;
}

export function formatMs(ms: number) {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const total = Math.round(ms / 1_000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}
export function durationText(op: ControlOp) {
  if (!op.startedAt || !op.finishedAt) return undefined;
  return formatMs(Date.parse(op.finishedAt) - Date.parse(op.startedAt));
}
export function span(ms: number) {
  const a = Math.abs(ms);
  if (a < 60_000) return "<1 min";
  if (a < 3_600_000) return `${Math.round(a / 60_000)} min`;
  if (a < 86_400_000) return `${Math.round(a / 3_600_000)} h`;
  return `${Math.round(a / 86_400_000)} d`;
}
export function relative(iso: string, expiry = false) {
  const delta = Date.parse(iso) - Date.now();
  if (expiry)
    return delta >= 0
      ? `expires in ${span(delta)}`
      : `expired ${span(delta)} ago`;
  return delta >= 0 ? `in ${span(delta)}` : `${span(delta)} ago`;
}
export function localStamp(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function shellArgv(argv: string[]) {
  return argv
    .map((arg) =>
      /^[A-Za-z0-9_/.:=@%+,-]+$/.test(arg)
        ? arg
        : `'${arg.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}
export function shortHash(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

// Takeover is shown with its earliest time, or the reason it is unavailable.
export function takeoverText(op: ControlOp) {
  const t = op.takeover;
  if (!t) return "";
  if (t.possible) return "Takeover available";
  if (t.at) return `Takeover possible after ${localStamp(t.at)}`;
  return t.reason ?? "Takeover unavailable";
}

// "offer expires in 12 min" or "offer expired 2 min ago".
export function offerExpiry(op: ControlOp) {
  return op.offerExpires ? `offer ${relative(op.offerExpires, true)}` : "";
}

// ---- React store: every change to the shared state goes through render() ----

// Clean machine and provider changes apply on their own. Host keys and credentials are trust
// decisions: any of them keeps the preview on screen for a person to confirm.
export function autoApplies(preview: Preview): boolean {
  const entries = preview.entries;
  if (!entries || preview.blocker || preview.conflicts.length > 0) return false;
  if (preview.changes.length === 0) return false;
  return entries.every((entry) => /^(machine|provider):/.test(entry.id));
}
