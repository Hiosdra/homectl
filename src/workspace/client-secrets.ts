// Applies central secret intents queued on the workspace server through this
// device's own SecretBroker (homelab #21 S1-S2, D8). Each intent runs at most
// once (deduplicated via seenIntents) and is refused when remote approval is
// off, the request is admin-only, or the local request already settled.
import type { BrokerRequestView, SecretProvideOptions } from "../secrets/types";
import { HomectlError } from "../types";
import type { DecisionOutcome } from "./client-decisions";
import type {
  PendingSecretSummary,
  ServerSecretIntent,
} from "./secret-intents";
import {
  type ClientLink,
  type ClientLinkFile,
  MAX_SEEN_INTENTS,
} from "./state";
import type { LinkedServer } from "./summary";

export interface WorkspaceClientSecretPort {
  canSave: boolean;
  pending(): BrokerRequestView[];
  provide(
    id: string,
    values: Record<string, string>,
    options: SecretProvideOptions,
  ): Promise<BrokerRequestView>;
  decline(id: string): BrokerRequestView;
}

export function summarizeSecret(
  view: BrokerRequestView,
  canSave: boolean,
): PendingSecretSummary {
  return {
    id: view.id,
    client: view.client,
    ...(view.task === undefined ? {} : { task: view.task }),
    purpose: { untrusted: view.purpose },
    destination: view.destination,
    fields: view.fields,
    admin: view.admin === true,
    canSave,
    requestExpiresAt: view.expiresAt,
  };
}

export class ClientSecretDecisions {
  private outcomes: DecisionOutcome[] = [];

  constructor(
    private readonly file: ClientLinkFile,
    private readonly load: () => Promise<ClientLink>,
    private readonly secrets: WorkspaceClientSecretPort,
    private readonly now: () => number,
  ) {}

  pendingSummaries(limit: number): PendingSecretSummary[] {
    return this.secrets
      .pending()
      .slice(0, limit)
      .map((item) => summarizeSecret(item, this.secrets.canSave));
  }

  peekOutcomes(): DecisionOutcome[] {
    return this.outcomes.slice();
  }

  ackOutcomes(count: number): void {
    this.outcomes.splice(0, count);
  }

  clearOutcomes(): void {
    this.outcomes = [];
  }

  async applyAll(
    intents: ServerSecretIntent[],
    serverId: string,
  ): Promise<boolean> {
    let applied = false;
    for (const intent of intents) {
      const outcome = await this.apply(intent, serverId);
      if (!outcome) continue;
      this.outcomes.push(outcome);
      applied = true;
    }
    return applied;
  }

  async apply(
    intent: ServerSecretIntent,
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
    return { id: intent.id, ...(await this.runIntent(intent, server)) };
  }

  private async runIntent(
    intent: ServerSecretIntent,
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
      if (intent.action === "decline") {
        this.secrets.decline(intent.secretId);
        return { status: "applied" };
      }
      const pending = this.secrets
        .pending()
        .find((item) => item.id === intent.secretId);
      if (pending?.admin)
        return {
          status: "refused",
          reason: "admin secret must be provided on its own device",
        };
      if (!intent.values || !intent.retention)
        return { status: "refused", reason: "secret values missing" };
      await this.secrets.provide(intent.secretId, intent.values, {
        retention: intent.retention,
        reuse: intent.reuse === true,
        ...(intent.saveName === undefined ? {} : { saveName: intent.saveName }),
      });
      return { status: "applied" };
    } catch (error) {
      return {
        status: "refused",
        reason:
          error instanceof HomectlError
            ? error.message.slice(0, 300)
            : "The local secret response failed",
      };
    }
  }
}
