// PolicyPort backed by the authz engine and the owner's policy file
// (homelab #21 B5/B6). The file lives in broker state, so only the broker
// (and the owner through it) can change it. A missing file starts from the
// conservative preset; it is written on first save, never on read.
import { randomBytes } from "node:crypto";
import {
  defaultPolicy,
  evaluate,
  loadPolicy,
  type Preset,
  type Reviewer,
  ruleFromDecision,
  savePolicy,
} from "../authz";
import type {
  ActionRequest,
  PolicyDecision,
  PolicyDocument,
} from "../core/contracts";
import { HomectlError } from "../types";
import type { PolicyContext, PolicyPort } from "./types";

export interface AuthzPolicyOptions {
  path: string;
  now: () => number;
  preset?: Preset;
  // Resolved for each evaluation, so reviewer settings change without a
  // restart. Undefined, or a throw, means no reviewer: the owner decides.
  reviewer?: () => Promise<Reviewer | undefined>;
  reviewerTimeoutMs?: number;
}

export class AuthzPolicy implements PolicyPort {
  constructor(private readonly options: AuthzPolicyOptions) {}

  async document(): Promise<PolicyDocument> {
    try {
      return await loadPolicy(this.options.path);
    } catch (error) {
      if (
        error instanceof HomectlError &&
        error.message === "Policy file not found"
      )
        return defaultPolicy(
          this.options.preset ?? "conservative",
          this.options.now(),
        );
      throw error;
    }
  }

  async revision(): Promise<number> {
    return (await this.document()).revision;
  }

  async budgetWindowMs(): Promise<number> {
    return (await this.document()).budgets.clientWindowMs;
  }

  async evaluate(
    req: ActionRequest,
    ctx: PolicyContext,
  ): Promise<PolicyDecision> {
    const reviewer = await this.resolveReviewer();
    const decision = await evaluate(req, {
      ...ctx,
      policy: await this.document(),
      ...(reviewer ? { reviewer } : {}),
      ...(this.options.reviewerTimeoutMs !== undefined
        ? { reviewerTimeoutMs: this.options.reviewerTimeoutMs }
        : {}),
    });
    // The reviewer's own words stay out of the engine decision; the panel
    // shows them separately as untrusted model output.
    const { reviewerReason: _ignored, ...engine } = decision;
    return engine;
  }

  // A broken reviewer configuration must not fail the request: without a
  // reviewer the evaluator asks the owner.
  private async resolveReviewer(): Promise<Reviewer | undefined> {
    try {
      return await this.options.reviewer?.();
    } catch {
      return undefined;
    }
  }

  // Saves an exact rule built from the request the owner just decided.
  async remember(
    req: ActionRequest,
    effect: "allow" | "deny",
  ): Promise<string> {
    const id = `remembered-${randomBytes(6).toString("hex")}`;
    const rule = ruleFromDecision(req, effect, this.options.now(), id);
    const doc = await this.document();
    await savePolicy(this.options.path, {
      ...doc,
      rules: [...doc.rules, rule],
    });
    return id;
  }

  async save(doc: PolicyDocument): Promise<PolicyDocument> {
    return savePolicy(this.options.path, doc);
  }
}
