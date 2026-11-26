// Owner decisions queued for clients (homelab #21 §6): their states, expiry
// and the bounded history kept for duplicate checks. The server only queues
// and records these; each client applies one through its own engine.
import type { Intent, LinkedClient } from "./state";
import type * as v from "./validate";

export const INTENT_MS = 120_000;
const MAX_INTENTS = 256;
const KEEP_FINISHED = 128;
export const FINISHED = new Set(["applied", "refused"]);

export function publicIntent(intent: Intent) {
  return {
    id: intent.id,
    operationId: intent.operationId,
    fingerprint: intent.fingerprint,
    decision: intent.decision,
    stepUp: intent.stepUp,
    expiresAt: intent.expiresAt,
  };
}

export function applyResults(
  client: LinkedClient,
  results: v.IntentResult[],
): void {
  for (const result of results) {
    const intent = client.intents.find((item) => item.id === result.id);
    if (!intent || FINISHED.has(intent.status)) continue;
    intent.status = result.status;
    intent.reason = result.status === "refused" ? result.reason : undefined;
  }
}

export function expireIntents(client: LinkedClient, now: number): void {
  for (const intent of client.intents)
    if (!FINISHED.has(intent.status) && intent.expiresAt < now) {
      intent.status = "refused";
      intent.reason = "expired";
    }
}

// Keeps the newest finished intents for duplicate checks; open ones are kept.
export function pruneIntents(client: LinkedClient): void {
  if (client.intents.length <= MAX_INTENTS) return;
  const finished = client.intents
    .filter((item) => FINISHED.has(item.status))
    .slice(-KEEP_FINISHED);
  const keep = new Set(finished);
  client.intents = client.intents.filter(
    (item) => !FINISHED.has(item.status) || keep.has(item),
  );
}
