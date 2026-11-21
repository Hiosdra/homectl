// Applies one client sync to the server state (homelab #21 §6). This is a state
// change only: the caller persists it and then emits the live events it lists.
import { HomectlError } from "../types";
import {
  applyResults,
  expireIntents,
  FINISHED,
  pruneIntents,
  publicIntent,
} from "./intents";
import {
  ingestEvents,
  type Intent,
  linked,
  type PendingSummary,
  type ServerState,
} from "./state";
import type { SyncRequest } from "./validate";

export interface SyncReply {
  ack: number;
  gap: boolean;
  intents?: ReturnType<typeof publicIntent>[];
  backupRequested?: boolean;
}

export interface SyncOutcome {
  reply: SyncReply;
  name: string;
  // Pending items this sync brought in for the first time, not yet expired.
  requested: PendingSummary[];
  // Intents that reached applied or refused during this sync.
  decided: Intent[];
}

export function applySync(
  state: ServerState,
  client: string,
  request: SyncRequest,
  now: number,
): SyncOutcome {
  const current = linked(state, client);
  if (!current) throw new HomectlError(3, "Unknown workspace client");
  current.lastSeenAt = now;
  current.remoteApproval = request.status.remoteApproval;
  current.vaultUnlocked = request.status.vaultUnlocked;
  if (request.status.backup) current.backupReport = request.status.backup;
  if (request.status.revocations)
    current.revocations = request.status.revocations;
  const known = new Set(current.pending.map((item) => item.id));
  const requested = request.pending.filter(
    (item) => !known.has(item.id) && item.expiresAt > now,
  );
  current.pending = request.pending;
  const ingest = ingestEvents(current.mirror, request.events, request.after);
  const open = new Set(
    current.intents
      .filter((item) => !FINISHED.has(item.status))
      .map((item) => item.id),
  );
  applyResults(current, request.intentResults);
  expireIntents(current, now);
  const decided = current.intents.filter(
    (item) => open.has(item.id) && FINISHED.has(item.status),
  );
  const base = { requested, decided, name: current.name };
  if (ingest.gap) return { ...base, reply: { ack: ingest.lastSeq, gap: true } };
  const intents = current.intents.filter((item) => !FINISHED.has(item.status));
  for (const intent of intents)
    if (intent.status === "queued") intent.status = "delivered";
  pruneIntents(current);
  // A requested backup is delivered once, then cleared.
  const backupRequested = current.backupRequested === true;
  current.backupRequested = false;
  return {
    ...base,
    reply: {
      ack: ingest.lastSeq,
      gap: false,
      intents: intents.map(publicIntent),
      backupRequested,
    },
  };
}
