// Pure helpers for the workspace client: what leaves the device (pending
// summaries, bounded event batches) and how errors are worded for the owner.

import type { BrokerOperation } from "../broker/types";
import type { EventEnvelope } from "../core/contracts";
import { HomectlError } from "../types";
import type { ClientLink, PendingSummary } from "./state";
import * as v from "./validate";

export const MAX_TEXT = 4096;
const MAX_BATCH_BYTES = 512 * 1024;
export type LinkedServer = NonNullable<ClientLink["server"]>;

export function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// What the owner sees of one pending operation on this device. Requester
// narrative is passed on as untrusted text only.
export function summarize(op: BrokerOperation): PendingSummary {
  return {
    id: clip(op.id, 128),
    client: clip(op.client, 128),
    host: clip(op.host, 255),
    argv: op.argv.slice(0, 256).map((arg) => clip(arg, MAX_TEXT)),
    risk: clip(op.risk, 64),
    fingerprint: clip(op.fingerprint, 256),
    reason: clip(op.decision.reason, 512),
    stepUp: op.decision.stepUp === true,
    humanOnly: op.decision.humanOnly === true,
    expiresAt: op.expiresAt,
    ...(op.narrative
      ? { narrative: { untrusted: clip(op.narrative, MAX_TEXT) } }
      : {}),
  };
}

// Events in order, bounded by count and encoded size for one request.
export function takeBatch(events: EventEnvelope[]): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  let total = 0;
  for (const event of events) {
    if (out.length >= v.MAX_SYNC_EVENTS) break;
    const size = JSON.stringify(event).length;
    if (out.length > 0 && total + size > MAX_BATCH_BYTES) break;
    total += size;
    out.push(event);
  }
  return out;
}

export function errorText(error: unknown): string {
  return error instanceof HomectlError
    ? error.message.slice(0, 300)
    : "Workspace request failed";
}

export function peerOf(server: LinkedServer) {
  return { id: server.id, key: server.key };
}
