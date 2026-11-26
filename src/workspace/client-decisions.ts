// Applies the owner decisions queued on the server (homelab #21 §6). Each one
// runs through this device's own engine and its own approval policy, at most
// once: the intent id is recorded before the decision runs, so a crash cannot
// apply it twice. The outcome is reported back on the next sync.
import type { DecideInput } from "../broker/types";
import { HomectlError } from "../types";
import {
  type ClientLink,
  type ClientLinkFile,
  MAX_SEEN_INTENTS,
} from "./state";
import type { LinkedServer } from "./summary";
import type * as v from "./validate";

export interface DecisionOutcome {
  id: string;
  status: "applied" | "refused";
  reason?: string;
}

export interface DecisionAcceptance {
  accepted: boolean;
  reason?: string;
}

export class ClientDecisions {
  constructor(
    private readonly file: ClientLinkFile,
    private readonly load: () => Promise<ClientLink>,
    private readonly decide: (
      input: DecideInput,
    ) => Promise<DecisionAcceptance>,
    private readonly now: () => number,
  ) {}

  // Returns the outcome, or undefined when the intent belongs to another
  // server or was already applied.
  async apply(
    intent: v.ServerIntent,
    serverId: string,
  ): Promise<DecisionOutcome | undefined> {
    const link = await this.load();
    const server = link.server;
    if (!server || server.id !== serverId) return undefined;
    if (link.seenIntents.includes(intent.id)) return undefined;
    await this.file.update((next) => {
      next.seenIntents.push(intent.id);
      next.seenIntents.splice(
        0,
        Math.max(0, next.seenIntents.length - MAX_SEEN_INTENTS),
      );
    });
    return { id: intent.id, ...(await this.decideIntent(intent, server)) };
  }

  private async decideIntent(
    intent: v.ServerIntent,
    server: LinkedServer,
  ): Promise<{ status: "applied" | "refused"; reason?: string }> {
    if (!server.remoteApproval)
      return {
        status: "refused",
        reason: "remote approval not granted on this client",
      };
    if (intent.expiresAt < this.now())
      return { status: "refused", reason: "expired" };
    try {
      const result = await this.decide({
        operationId: intent.operationId,
        fingerprint: intent.fingerprint,
        decision: intent.decision,
        surface: `workspace-server:${server.id}`,
        // A server's re-authentication never satisfies local step-up.
        stepUp: false,
      });
      return result.accepted
        ? { status: "applied" }
        : {
            status: "refused",
            reason: result.reason ?? "The local decision was refused",
          };
    } catch (error) {
      return {
        status: "refused",
        reason:
          error instanceof HomectlError
            ? error.message.slice(0, 300)
            : "The local decision failed",
      };
    }
  }
}
