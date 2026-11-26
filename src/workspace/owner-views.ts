// Read-only owner views over the server state (homelab #21 §6): the pending
// approvals of linked clients with the status of the decision queued for each,
// and the recent intents. Nothing here changes state.
import type { Intent, LinkedClient, ServerState } from "./state";
import { linked } from "./state";

export const INTENT_LIST_DEFAULT = 50;
export const INTENT_LIST_MAX = 200;

export interface IntentView {
  id: string;
  decision: Intent["decision"];
  status: Intent["status"];
  reason?: string;
  expiresAt: number;
}

export interface IntentRow extends IntentView {
  operationId: string;
  client: string;
}

export function intentView(intent: Intent): IntentView {
  return {
    id: intent.id,
    decision: intent.decision,
    status: intent.status,
    ...(intent.reason === undefined ? {} : { reason: intent.reason }),
    expiresAt: intent.expiresAt,
  };
}

// Pending items that have not expired, each with the newest intent for its
// operation (null when none was queued).
export function pendingRows(state: ServerState, now: number) {
  return Object.entries(state.clients).flatMap(([id, client]) =>
    client.pending
      .filter((item) => item.expiresAt > now)
      .map((item) => {
        const latest = client.intents
          .filter((intent) => intent.operationId === item.id)
          .at(-1);
        return {
          origin: id,
          originName: client.name,
          ...item,
          intent: latest ? intentView(latest) : null,
        };
      }),
  );
}

// Newest first across the chosen clients, bounded by `limit`.
export function intentRows(
  state: ServerState,
  options: { client?: string; limit: number },
): { intents: IntentRow[] } {
  const scope: [string, LinkedClient][] =
    options.client === undefined
      ? Object.entries(state.clients)
      : scopeOf(state, options.client);
  const all = scope.flatMap(([id, client]) =>
    client.intents.map((intent) => ({ id, intent })),
  );
  all.sort((a, b) => b.intent.createdAt - a.intent.createdAt);
  return {
    intents: all.slice(0, options.limit).map(({ id, intent }) => ({
      ...intentView(intent),
      operationId: intent.operationId,
      client: id,
    })),
  };
}

function scopeOf(state: ServerState, id: string): [string, LinkedClient][] {
  const client = linked(state, id);
  return client ? [[id, client]] : [];
}
