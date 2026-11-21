// Evidence of clients that left the server (homelab #21 §6): removed, reset for
// a restore, or declined. Each keeps its last mirror (events and pending
// summaries) as read-only history, and its wrapped backup key, so its backups
// stay restorable. The history is bounded: the newest RETIRED_HISTORY_KEEP
// clients keep their mirror, and each mirror is capped. Retired ids stay in
// `removed`, so none of them can link again.
import type { EventEnvelope } from "../core/contracts";
import { HomectlError } from "../types";
import {
  linked,
  type PendingSummary,
  type RetiredClient,
  type RetireCause,
  type Revocations,
  type ServerState,
} from "./state";

export const MAX_RETIRED_EVENTS = 100;
export const MAX_RETIRED_PENDING = 50;
export const RETIRED_HISTORY_KEEP = 20;

export function isRetired(state: ServerState, id: string): boolean {
  return state.retired !== undefined && Object.hasOwn(state.retired, id);
}

// Moves a linked client to `retired`. Its record, link and queued work go.
export function retireClient(
  state: ServerState,
  id: string,
  cause: RetireCause,
  now: number,
): void {
  const current = linked(state, id);
  if (!current) throw new HomectlError(3, "Unknown workspace client");
  delete state.clients[id];
  const retired = state.retired ?? {};
  state.retired = retired;
  retired[id] = {
    name: current.name,
    platform: current.platform,
    joinedAt: current.joinedAt,
    retiredAt: now,
    cause,
    ...(current.wrappedBackupKey
      ? { wrappedBackupKey: current.wrappedBackupKey }
      : {}),
    ...(current.revocations ? { revocations: current.revocations } : {}),
    historyKept: true,
    mirror: {
      lastSeq: current.mirror.lastSeq,
      events: current.mirror.events.slice(-MAX_RETIRED_EVENTS),
      gaps: current.mirror.gaps ?? 0,
    },
    pending: current.pending.slice(0, MAX_RETIRED_PENDING),
  };
  if (!state.removed.includes(id)) state.removed.push(id);
  trimHistory(retired);
}

// Keeps the mirror of the newest RETIRED_HISTORY_KEEP clients. The others keep
// only their key and identity, so their history stays restorable.
function trimHistory(retired: Record<string, RetiredClient>): void {
  const newest = Object.entries(retired).sort(
    (a, b) => b[1].retiredAt - a[1].retiredAt,
  );
  for (const [, entry] of newest.slice(RETIRED_HISTORY_KEEP)) {
    entry.historyKept = false;
    entry.mirror = { ...entry.mirror, events: [] };
    entry.pending = [];
  }
}

// The revocations a retired client last reported, for a restore of it.
export function retiredRevocations(
  state: ServerState,
  id: string,
): Revocations | undefined {
  return state.retired && Object.hasOwn(state.retired, id)
    ? state.retired[id]?.revocations
    : undefined;
}

export interface RetiredRow {
  id: string;
  name: string;
  platform: string;
  cause: RetireCause;
  joinedAt: number;
  retiredAt: number;
  restorable: boolean;
  historyKept: boolean;
  mirror: { lastSeq: number; gaps: number; events: number };
  pending: number;
}

export function retiredRows(state: ServerState): RetiredRow[] {
  return Object.entries(state.retired ?? {})
    .sort((a, b) => b[1].retiredAt - a[1].retiredAt)
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      platform: entry.platform,
      cause: entry.cause,
      joinedAt: entry.joinedAt,
      retiredAt: entry.retiredAt,
      restorable: entry.wrappedBackupKey !== undefined,
      historyKept: entry.historyKept,
      mirror: {
        lastSeq: entry.mirror.lastSeq,
        gaps: entry.mirror.gaps,
        events: entry.mirror.events.length,
      },
      pending: entry.pending.length,
    }));
}

// The row plus the mirrored events and pending summaries, read-only.
export function retiredHistory(
  state: ServerState,
  id: string,
):
  | { row: RetiredRow; events: EventEnvelope[]; pending: PendingSummary[] }
  | undefined {
  const row = retiredRows(state).find((item) => item.id === id);
  if (!row || !state.retired) return undefined;
  const entry = state.retired[id];
  if (!entry) return undefined;
  return { row, events: entry.mirror.events, pending: entry.pending };
}
