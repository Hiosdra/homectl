// Live owner events for the workspace server (homelab #21 §6, "Live UX"). When a
// client's sync brings a new pending approval, the server emits
// approval.requested; when an intent reaches applied or refused, it emits
// approval.decided. Both go into the server's own event log with an empty
// audience, so only owner surfaces receive them (see events/filter.ts). Ordinary
// clients never see another client's items.
//
// The data carries ids, the client and the host, and nothing else from the
// operation: no argv, narrative or fingerprint. The owner reads those from the
// pending route, which is already owner-only. Every item has one canonical id,
// "<client link id>:<operation id>", so a panel that gets the same item by push
// and by poll shows it once.
import type { PendingSummary, Intent } from "./state";

// What the server hands to its event port: the broker's EventsPort.emit shape.
export interface LiveEvent {
  type: "approval.requested" | "approval.decided";
  subject: string;
  audience: string[];
  data: Record<string, unknown>;
}

const OWNER_ONLY: string[] = [];

export function canonicalId(client: string, operationId: string): string {
  return `${client}:${operationId}`;
}

export function requestedEvent(
  client: { id: string; name: string },
  item: PendingSummary,
): LiveEvent {
  const id = canonicalId(client.id, item.id);
  return {
    type: "approval.requested",
    subject: id,
    audience: OWNER_ONLY,
    data: {
      id,
      operationId: item.id,
      client: client.id,
      clientName: client.name,
      host: item.host,
      risk: item.risk,
      stepUp: item.stepUp,
      humanOnly: item.humanOnly,
      expiresAt: item.expiresAt,
    },
  };
}

// The intent must already be applied or refused.
export function decidedEvent(clientId: string, intent: Intent): LiveEvent {
  const id = canonicalId(clientId, intent.operationId);
  return {
    type: "approval.decided",
    subject: id,
    audience: OWNER_ONLY,
    data: {
      id,
      operationId: intent.operationId,
      client: clientId,
      intentId: intent.id,
      decision: intent.decision,
      status: intent.status,
      ...(intent.reason === undefined ? {} : { reason: intent.reason }),
    },
  };
}
