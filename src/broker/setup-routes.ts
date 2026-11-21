// Owner routes for the guided setup (audit B2-B3, C1-C2). GET /v1/owner/setup reads
// every step's detected and stored state; POST /v1/owner/setup/step records a
// progress mark. Neither changes security state, so neither asks for the owner
// password. Both need the owner session and the usual Origin check (server.ts).
// The marks are limited on purpose: "keep this" only for permissions, "done" only
// for notifications (a check made in the browser), and nothing that could stand in
// for a real check such as a vault, a machine or an assistant.
import { HomectlError } from "../types";
import { buildStatus, type SetupFacts, type SetupStatus } from "./setup-detect";
import {
  isSetupStep,
  type SetupFile,
  type SetupStepId,
  type SetupStore,
} from "./setup-state";
import type { RouteExtension } from "./server";

export const SETUP_ACTIONS = [
  "welcome",
  "skip",
  "reopen",
  "keep",
  "done",
  "dismiss",
  "upgrade-ack",
] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

export interface SetupRoutesOptions {
  store: SetupStore;
  facts(): Promise<SetupFacts>;
}

function requireStep(value: unknown): SetupStepId {
  if (!isSetupStep(value)) throw new HomectlError(2, "Unknown setup step");
  return value;
}

export class SetupRoutes implements RouteExtension {
  constructor(private readonly options: SetupRoutesOptions) {}

  async owner(
    path: string,
    input: Record<string, unknown>,
  ): Promise<unknown | undefined> {
    if (path === "/v1/owner/setup") return this.status();
    if (path === "/v1/owner/setup/step") return this.mark(input);
    return undefined;
  }

  private async read(): Promise<{ file: SetupFile; status: SetupStatus }> {
    const facts = await this.options.facts();
    const file = await this.options.store.load();
    return { file, status: buildStatus(file, facts) };
  }

  // The first complete read records when setup was finished. Only the timestamp
  // is written; the live status decides what the panel shows.
  private async status(): Promise<SetupStatus> {
    const { file, status } = await this.read();
    if (!status.completed || file.completedAt !== undefined) return status;
    await this.options.store.update((next, at) => {
      next.completedAt = at;
    });
    return (await this.read()).status;
  }

  private async mark(input: Record<string, unknown>): Promise<SetupStatus> {
    const action = input.action;
    if (!(SETUP_ACTIONS as readonly unknown[]).includes(action))
      throw new HomectlError(2, "Unknown setup action");
    switch (action as SetupAction) {
      case "welcome":
        await this.options.store.update((file, at) => {
          file.welcomedAt ??= at;
        });
        break;
      case "upgrade-ack":
        await this.options.store.update((file, at) => {
          if (file.upgradedAt !== undefined) file.upgradeAckAt = at;
        });
        break;
      case "dismiss": {
        const { status } = await this.read();
        if (!status.completed)
          throw new HomectlError(2, "Finish setup before hiding the checklist");
        await this.options.store.update((file, at) => {
          file.dismissedAt ??= at;
        });
        break;
      }
      case "skip": {
        const step = requireStep(input.step);
        await this.options.store.update((file, at) => {
          file.steps[step] = { status: "skipped", at };
        });
        break;
      }
      case "reopen": {
        const step = requireStep(input.step);
        await this.options.store.update((file) => {
          delete file.steps[step];
        });
        break;
      }
      case "keep": {
        if (input.step !== "permissions")
          throw new HomectlError(2, "Only permissions can be kept as they are");
        await this.options.store.update((file, at) => {
          file.steps.permissions = { status: "done", at };
        });
        break;
      }
      case "done": {
        if (input.step !== "notifications")
          throw new HomectlError(2, "Only notifications can be marked here");
        await this.options.store.update((file, at) => {
          file.steps.notifications = { status: "done", at };
        });
        break;
      }
    }
    return this.status();
  }
}
