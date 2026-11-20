// Human time for the owner panel: "in 12 minutes", "2 hours ago". The exact
// time stays available in a title attribute. Pure functions, so they test without
// a browser.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// The size of a gap, in the largest sensible unit. Never "0 minutes".
export function spanOf(ms: number): string {
  const size = Math.abs(ms);
  if (size < MINUTE) return "less than a minute";
  if (size < HOUR) return plural(Math.round(size / MINUTE), "minute");
  if (size < 2 * DAY) return plural(Math.round(size / HOUR), "hour");
  return plural(Math.round(size / DAY), "day");
}

// "just now", "5 minutes ago", "in 12 minutes".
export function relativeTime(at: number, now = Date.now()): string {
  const diff = at - now;
  if (Math.abs(diff) < 30_000) return "just now";
  return diff > 0 ? `in ${spanOf(diff)}` : `${spanOf(diff)} ago`;
}

// "expires in 9 minutes", or "expired" once the time has passed.
export function expiresIn(at: number, now = Date.now()): string {
  const diff = at - now;
  if (diff <= 0) return "expired";
  return `expires in ${spanOf(diff)}`;
}

// Accepts the broker's epoch milliseconds or an ISO string. Undefined when the
// value cannot be read, so callers can fall back to the raw text.
export function toEpoch(
  value: number | string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const at = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}
