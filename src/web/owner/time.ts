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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const pad = (n: number) => String(n).padStart(2, "0");

// The exact local time a request waits for the owner until: "Waiting for you
// until 14:05", or with the day when it is not today: "Waiting for you until
// Tue 24 Nov, 14:05". Once the time has passed: "Expired".
export function waitingUntil(at: number, now = Date.now()): string {
  if (at - now <= 0) return "Expired";
  const date = new Date(at);
  const today = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const when = sameDay
    ? clock
    : `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${clock}`;
  return `Waiting for you until ${when}`;
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
