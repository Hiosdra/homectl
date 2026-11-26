// Owner routes for Auto Mode (homelab #21 A1). Reads never change anything.
// A change first checks the owner password when it widens the reviewer
// authority, turns Auto Mode on, or sends the reviewer to a new endpoint. Every
// saved change emits a settings.updated event for the owner.
import type { PolicyDocument } from "../core/contracts";
import {
  type AutoModeChange,
  autoModeView,
  endpointOrigin,
  parseAutoModeChange,
  planAutoMode,
} from "./auto-mode";
import type { PolicyDocumentStore } from "./policy-routes";
import { keyStatus, type ReviewerKeyStore } from "./reviewer-key";
import {
  loadReviewerSettings,
  type ReviewerSettings,
  saveReviewerSettings,
} from "./reviewer-settings";
import type { RouteExtension } from "./server";
import type { EventsPort } from "./types";

export interface AutoModeRoutesOptions {
  store: PolicyDocumentStore;
  settingsPath: string;
  env: Record<string, string | undefined>;
  // The vault-backed key. Without it, only the environment variable counts.
  keys?: ReviewerKeyStore;
  events?: EventsPort;
}

export class AutoModeRoutes implements RouteExtension {
  constructor(private readonly options: AutoModeRoutesOptions) {}

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    switch (path) {
      case "/v1/owner/auto-mode/get":
        return this.view(
          await this.options.store.document(),
          await loadReviewerSettings(this.options.settingsPath),
        );
      case "/v1/owner/auto-mode/set":
        return this.set(parseAutoModeChange(input), input.password, stepUp);
      default:
        return undefined;
    }
  }

  view(doc: PolicyDocument, settings: ReviewerSettings) {
    const { env, keys } = this.options;
    return autoModeView(doc, settings, keyStatus(env, keys, settings));
  }

  private async set(
    change: AutoModeChange,
    password: unknown,
    stepUp: (password: unknown) => Promise<void>,
  ) {
    const doc = await this.options.store.document();
    const settings = await loadReviewerSettings(this.options.settingsPath);
    const plan = planAutoMode(doc, settings, change);
    // Checked before anything is written.
    if (plan.stepUp) await stepUp(password);
    // The policy is saved first. If the settings write then fails, the owner
    // gets the error and must repeat the change; until then the reviewer uses
    // the endpoint already on disk, or none, which means the owner decides.
    const saved = await this.options.store.save(plan.doc);
    await saveReviewerSettings(this.options.settingsPath, plan.settings);
    await this.options.events?.emit(
      "settings.updated",
      "auto-mode",
      ["owner"],
      {
        policyRevision: saved.revision,
        mode: saved.mode,
        authority: saved.reviewer.authority,
        endpoint: endpointOrigin(plan.settings),
        stepUp: plan.stepUp,
      },
    );
    return this.view(saved, plan.settings);
  }
}
