import { randomUUID } from "node:crypto";
import { appendLocalAudit } from "../control/journal";
import { normalizeAuditArgv } from "../control/redact";
import { loadInventory } from "../inventory";
import { execute } from "../operations";
import { planExecution } from "../policies";
import { sessionStatus } from "../session";
import { type ExecutionPlan, HomectlError } from "../types";
import type { Hub } from "./hub";
import type { Peer } from "./store";

export async function peerCommand(hub: Hub, peer: Peer, payload: unknown) {
  const v = payload as {
    host: string;
    argv: string[];
    impact?: string;
    approval?: string;
    dryRun?: boolean;
  };
  if (!peer.permissions.operations.includes(v.host))
    throw new HomectlError(3, "Peer has no operation grant for this host");
  const inventory = await loadInventory(hub.inventoryPath);
  const machine = inventory.machines[v.host];
  if (!machine) throw new HomectlError(2, "Unknown host");
  if (machine.transport === "local" && !peer.permissions.administer)
    throw new HomectlError(3, "Peer administration is disabled");
  if (
    !Array.isArray(v.argv) ||
    !v.argv.length ||
    v.argv.some((arg) => typeof arg !== "string" || arg.length > 4096)
  )
    throw new HomectlError(2, "Invalid command");
  let plan: ExecutionPlan;
  try {
    plan = planExecution(v.host, machine, v.argv, v.impact);
  } catch (error) {
    if (!v.dryRun) {
      try {
        await appendLocalAudit(hub.inventoryPath, {
          event: "command.refused",
          op: "execute",
          operationId: randomUUID(),
          client: "local-operator",
          device: peer.id,
          deviceName: peer.name,
          host: v.host,
          argv: normalizeAuditArgv(v.argv),
          policyDecision: "refused",
          reason: "policy-refused",
        });
      } catch {
        console.warn(
          "Could not record the refused peer command in the audit journal.",
        );
      }
    }
    throw error;
  }
  if (plan.classification !== "inspect" && !v.dryRun) {
    for (const [id, operation] of hub.operations)
      if (operation.expiresAt < Date.now()) hub.operations.delete(id);
    if (hub.operations.size >= 32)
      throw new HomectlError(3, "Too many pending operations");
    const id = randomUUID();
    await appendLocalAudit(hub.inventoryPath, {
      event: "command.approval-required",
      op: "execute",
      operationId: id,
      client: "local-operator",
      device: peer.id,
      deviceName: peer.name,
      host: v.host,
      argv: normalizeAuditArgv(v.argv),
      classification: plan.classification,
      policyDecision: "needs-approval",
      reason: "peer-approval-required",
    });
    hub.operations.set(id, {
      id,
      peerId: peer.id,
      operationId: id,
      host: v.host,
      argv: v.argv,
      impact: v.impact,
      approval: plan.approval,
      expiresAt: Date.now() + 300_000,
      state: "pending",
    });
    return { pending: true, id, approvalNeededOn: hub.state.name };
  }
  if (
    !v.dryRun &&
    !hub.vault.unlocked &&
    !(await sessionStatus(hub.inventoryPath)).unlocked
  )
    throw new HomectlError(
      5,
      "Unlock the execution device locally before running a peer operation",
    );
  return execute(v.host, machine, v.argv, {
    configPath: hub.configPath,
    dryRun: v.dryRun,
    impact: v.impact,
    audit: {
      inventoryPath: hub.inventoryPath,
      device: peer.id,
      deviceName: peer.name,
    },
  });
}
