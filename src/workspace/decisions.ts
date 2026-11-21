// Queues one owner decision for an operation on a linked client (homelab #21
// §6). The server checks the operation is really waiting, with the same
// fingerprint and inside its expiry, then refuses step-up operations for
// approve-once: the owner must approve those on the origin device.
import { randomUUID } from "node:crypto";
import { HomectlError } from "../types";
import { INTENT_MS } from "./intents";
import type { Intent, ServerStateFile } from "./state";
import { linked } from "./state";
import * as v from "./validate";

export async function queueDecision(
  file: ServerStateFile,
  now: number,
  input: Record<string, unknown>,
  stepUp: (password: unknown) => Promise<void>,
): Promise<Intent> {
  const id = v.text(input.client, "client", 64);
  const operationId = v.text(input.operationId, "operation id", 128);
  const fingerprint = v.text(input.fingerprint, "fingerprint", 256);
  const decision = input.decision;
  if (decision !== "approve-once" && decision !== "deny-once")
    throw new HomectlError(2, "Unknown decision");
  const client = linked(await file.read(), id);
  if (!client) throw new HomectlError(3, "Unknown workspace client");
  if (client.remoteApproval !== true)
    throw new HomectlError(
      3,
      "This client does not accept approvals from this server",
    );
  const op = client.pending.find(
    (item) =>
      item.id === operationId &&
      item.fingerprint === fingerprint &&
      item.expiresAt > now,
  );
  if (!op)
    throw new HomectlError(
      3,
      "That operation is not waiting for approval with this fingerprint",
    );
  // Step-up is proof of the owner's presence on the origin device. A
  // server's own re-authentication does not stand in for it.
  if (decision === "approve-once" && op.stepUp)
    throw new HomectlError(
      3,
      "This operation needs step-up; approve it on its own device",
    );
  if (input.password !== undefined) await stepUp(input.password);
  const intent: Intent = {
    id: randomUUID(),
    operationId,
    fingerprint,
    decision,
    stepUp: false,
    createdAt: now,
    expiresAt: Math.min(now + INTENT_MS, op.expiresAt),
    status: "queued",
  };
  return file.update((state) => {
    const current = linked(state, id);
    if (!current) throw new HomectlError(3, "Unknown workspace client");
    if (
      current.intents.some(
        (item) => item.operationId === operationId && item.status !== "refused",
      )
    )
      throw new HomectlError(
        3,
        "This operation already has a decision on its way",
      );
    current.intents.push(intent);
    return intent;
  });
}
