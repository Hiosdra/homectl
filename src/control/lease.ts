// Owner lease and takeover window (fencing rule, refines ADR-0002 decision 5).
//
// An owner may execute only while it has completed a successful sync round
// with every paired peer within the lease period. A takeover is possible only
// after the owner has been unreachable for lease + skew. Both are pure
// functions of the clock values the caller passes in, so tests can drive them.
export const LEASE_MS = 120_000;
export const SKEW_MS = 60_000;

export type SyncTimes = Record<string, number>; // peer id -> last successful sync

export function leaseCheck(
  peers: string[],
  lastSync: SyncTimes,
  now: number,
  leaseMs = LEASE_MS,
): { ok: true } | { ok: false; waitingFor: string[] } {
  // No paired peers means nobody else can own the operation: no lease needed.
  if (peers.length === 0) return { ok: true };
  const waitingFor = peers.filter((peer) => {
    const at = lastSync[peer];
    return at === undefined || now - at > leaseMs;
  });
  return waitingFor.length === 0 ? { ok: true } : { ok: false, waitingFor };
}

// Unknown last contact means no takeover (fail closed).
export function takeoverWindow(
  lastSeen: number | undefined,
  now: number,
  leaseMs = LEASE_MS,
  skew = SKEW_MS,
): { allowed: boolean; at?: number } {
  if (lastSeen === undefined) return { allowed: false };
  const at = lastSeen + leaseMs + skew;
  return { allowed: now >= at, at };
}

// Exponential backoff for a failing peer, capped.
export function backoffMs(
  failures: number,
  base = 5_000,
  max = 300_000,
): number {
  return Math.min(max, base * 2 ** Math.min(Math.max(failures, 0), 16));
}
