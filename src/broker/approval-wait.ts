// How long a request waits for the owner before it expires ("How long requests
// wait for you"). The default is 24 hours; the owner can set 5 minutes to 7 days.
// Only the approval wait is configurable: step-up sessions, grants and the
// short windows that guard them keep their own, shorter limits.
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicReplace, protect } from "../platform";
import { HomectlError } from "../types";

export const APPROVAL_WAIT_DEFAULT_MS = 24 * 60 * 60_000;
export const APPROVAL_WAIT_MIN_MS = 5 * 60_000;
export const APPROVAL_WAIT_MAX_MS = 7 * 24 * 60 * 60_000;

const FILE = "approval-wait.json";

// "90m", "24h", "7d", or a bare number of minutes. Bounded, never silently clamped.
export function parseApprovalWait(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw))
    return checkApprovalWaitMs(raw * 60_000);
  if (typeof raw !== "string") throw invalid();
  const match = /^(\d{1,6})\s*(m|min|h|d)?$/i.exec(raw.trim());
  if (!match) throw invalid();
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const minutes =
    unit === "d" ? amount * 1440 : unit === "h" ? amount * 60 : amount;
  return checkApprovalWaitMs(minutes * 60_000);
}

// A wait in milliseconds, already parsed. Refused, not clamped, outside the bounds.
export function checkApprovalWaitMs(raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < APPROVAL_WAIT_MIN_MS ||
    raw > APPROVAL_WAIT_MAX_MS
  )
    throw invalid();
  return raw;
}

function invalid(): HomectlError {
  return new HomectlError(
    2,
    "Choose a wait between 5 minutes and 7 days, for example 90m, 24h or 7d.",
  );
}

// Plain words for the panel and the CLI: "24 hours", "90 minutes", "7 days".
export function describeApprovalWait(ms: number): string {
  if (ms % (24 * 60 * 60_000) === 0) {
    const days = ms / (24 * 60 * 60_000);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (ms % (60 * 60_000) === 0) {
    const hours = ms / (60 * 60_000);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const minutes = ms / 60_000;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// Reads the saved wait. A missing or unreadable file means the default: the
// approval window never blocks a request because a settings file is damaged.
export async function readApprovalWait(directory: string): Promise<number> {
  try {
    const value = JSON.parse(await readFile(join(directory, FILE), "utf8")) as {
      version?: unknown;
      approvalWaitMs?: unknown;
    };
    if (
      value.version === 1 &&
      typeof value.approvalWaitMs === "number" &&
      Number.isSafeInteger(value.approvalWaitMs) &&
      value.approvalWaitMs >= APPROVAL_WAIT_MIN_MS &&
      value.approvalWaitMs <= APPROVAL_WAIT_MAX_MS
    )
      return value.approvalWaitMs;
  } catch {
    /* absent or unreadable: the default */
  }
  return APPROVAL_WAIT_DEFAULT_MS;
}

// Owner-only writes go through the owner routes, which check the password.
export async function writeApprovalWait(
  directory: string,
  raw: unknown,
): Promise<number> {
  const ms = checkApprovalWaitMs(raw);
  const path = join(directory, FILE);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temp,
      `${JSON.stringify({ version: 1, approvalWaitMs: ms }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await protect(temp);
    await atomicReplace(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return ms;
}
