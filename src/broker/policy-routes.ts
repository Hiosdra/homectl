// Owner routes for effective permissions (homelab #21 §4, F-effective policy).
// Reads are owner-only and never change anything. Preset changes and rule
// removal change what agents may do, so each one needs the owner password in
// the same request (step-up), like client creation does.
import {
  defaultPolicy,
  explainEffective,
  type Preset,
  RULE_ID_PATTERN,
} from "../authz";
import type { PolicyDocument } from "../core/contracts";
import { HomectlError } from "../types";
import type { RouteExtension } from "./server";

const PRESETS: readonly Preset[] = ["conservative", "routine", "delegated"];

// The part of AuthzPolicy these routes need. Kept narrow so tests can fake it.
export interface PolicyDocumentStore {
  document(): Promise<PolicyDocument>;
  save(doc: PolicyDocument): Promise<PolicyDocument>;
}

function text(value: unknown, field: string, optional = false): string {
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || !value || value.length > 200)
    throw new HomectlError(2, `${field} is required`);
  return value;
}

export class PolicyRoutes implements RouteExtension {
  constructor(
    private readonly store: PolicyDocumentStore,
    private readonly now: () => number = Date.now,
  ) {}

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    switch (path) {
      case "/v1/owner/policy/get":
        return this.store.document();
      case "/v1/owner/policy/explain": {
        const client = text(input.client, "client");
        const host =
          input.host === undefined
            ? undefined
            : text(input.host, "host", true) || undefined;
        return explainEffective(
          await this.store.document(),
          client,
          host,
          this.now(),
        );
      }
      case "/v1/owner/policy/preset": {
        await stepUp(input.password);
        const preset = text(input.preset, "preset") as Preset;
        if (!PRESETS.includes(preset))
          throw new HomectlError(2, "Unknown preset");
        // A preset sets only the mode and the reviewer authority. Rules and
        // budgets stay, so a remembered rule is never lost by switching.
        const current = await this.store.document();
        const target = defaultPolicy(preset, this.now());
        return this.store.save({
          ...current,
          mode: target.mode,
          reviewer: {
            ...current.reviewer,
            authority: target.reviewer.authority,
          },
        });
      }
      case "/v1/owner/policy/remove-rule": {
        await stepUp(input.password);
        const id = text(input.id, "id");
        if (!RULE_ID_PATTERN.test(id))
          throw new HomectlError(2, "Unknown rule");
        const current = await this.store.document();
        if (!current.rules.some((rule) => rule.id === id))
          throw new HomectlError(3, "No rule with that id");
        return this.store.save({
          ...current,
          rules: current.rules.filter((rule) => rule.id !== id),
        });
      }
      default:
        return undefined;
    }
  }
}
