import { fingerprint } from "../control/canonical";
import { proxmoxChanged } from "./proxmox-submit";
import type { ClientRecord } from "../control/types";
import type { BrokerOperation, BrokerState, InventoryPort } from "./types";

export type CurrentClient = (id: string) => Promise<ClientRecord | undefined>;

// Recheck the requester before an owner decision can install a remembered
// rule, and again before dispatch. Setup requests for a new host or a
// workspace setting have no host grant to check.
export async function authorityRefusal(
  op: BrokerOperation,
  state: BrokerState,
  now: number,
  currentClient?: CurrentClient,
): Promise<string | undefined> {
  if (op.task !== undefined) {
    const task = state.tasks[op.task];
    if (task?.state !== "open" || now >= task.expiresAt)
      return "task-no-longer-open";
  }
  if (!currentClient) return undefined;
  const client = await currentClient(op.client).catch(() => undefined);
  if (
    !client ||
    client.revokedAt !== undefined ||
    !client.scopes.includes("plan:create")
  )
    return "client-grant-changed";
  const kind = op.setup?.kind;
  const needsHost =
    kind === undefined ||
    kind === "access" ||
    kind === "probe" ||
    kind === "remove" ||
    kind === "sudo-grant";
  if (needsHost && !client.hosts.includes(op.host))
    return "client-grant-changed";
  return undefined;
}

export async function approvalRefusal(
  op: BrokerOperation,
  state: BrokerState,
  now: number,
  approving: boolean,
  options: { inventory: InventoryPort; currentClient?: CurrentClient },
): Promise<string | undefined> {
  const machine = await options.inventory.machine(op.host);
  if (
    (!machine && op.setup === undefined) ||
    fingerprint(machine ?? null) !== op.machineHash ||
    (await proxmoxChanged(options.inventory, op))
  )
    return "plan-changed";
  if (approving) return authorityRefusal(op, state, now, options.currentClient);
  return undefined;
}
