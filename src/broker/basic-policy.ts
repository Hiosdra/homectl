// Fixed fallback policy used until an owner policy document exists (and in
// tests): safe inspection runs, everything else asks the owner, R3/R4 need
// step-up. Deterministic, zero model calls.
import {
  type ActionRequest,
  HUMAN_ONLY_KINDS,
  type PolicyDecision,
  riskAtLeast,
} from "../core/contracts";
import type { PolicyContext, PolicyPort } from "./types";

export class BasicPolicy implements PolicyPort {
  constructor(private readonly rev = 1) {}

  async revision(): Promise<number> {
    return this.rev;
  }

  async evaluate(
    req: ActionRequest,
    ctx: PolicyContext,
  ): Promise<PolicyDecision> {
    const base = { modelCalls: 0, policyRevision: this.rev };
    if (!ctx.knownHost && req.host)
      return {
        ...base,
        verdict: "deny",
        source: "invariant",
        reason: "Unknown host",
        humanOnly: false,
        stepUp: false,
      };
    const humanOnly =
      HUMAN_ONLY_KINDS.includes(req.kind) || riskAtLeast(req.risk, "R4");
    const stepUp = riskAtLeast(req.risk, "R3") || humanOnly;
    if (ctx.task && ctx.task.state !== "open")
      return {
        ...base,
        verdict: "deny",
        source: "invariant",
        reason: "The task is closed or expired",
        humanOnly: false,
        stepUp: false,
      };
    if (
      !humanOnly &&
      (req.kind === "exec" || req.kind === "proxmox") &&
      req.classification === "inspect" &&
      !req.sudo
    )
      return {
        ...base,
        verdict: "allow",
        source: "default",
        reason: "Safe inspection command",
        humanOnly: false,
        stepUp: false,
      };
    return {
      ...base,
      verdict: "ask",
      source: humanOnly ? "hard-gate" : "default",
      reason: humanOnly
        ? "Only the owner can approve this kind of action"
        : "Needs the owner's approval",
      humanOnly,
      stepUp,
    };
  }
}
