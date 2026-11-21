// Turns an agent's Proxmox request into the operation base and the policy
// request the engine submits. Grants are checked before the provider is read,
// so an ungranted host and an unknown host get the same refusal.
import { hasScope, permitsHost } from "../control/clients";
import { fingerprint } from "../control/canonical";
import type { ClientIdentity } from "../control/types";
import type { ActionRequest } from "../core/contracts";
import { HomectlError } from "../types";
import { planProxmox, validateProxmoxInput } from "./proxmox-plan";
import type { OperationBase } from "./submit";
import type { BrokerOperation, InventoryPort } from "./types";

const NOT_GRANTED = "Host is not in this client's grants";

export interface PlannedProxmoxRequest {
  base: OperationBase;
  request: ActionRequest;
  narrative?: string;
}

export async function planProxmoxRequest(
  inventory: InventoryPort,
  client: ClientIdentity,
  raw: unknown,
): Promise<PlannedProxmoxRequest> {
  const input = validateProxmoxInput(raw);
  if (!hasScope(client, "plan:create") || !permitsHost(client, input.host))
    throw new HomectlError(3, NOT_GRANTED);
  const machine = await inventory.machine(input.host);
  if (!machine) throw new HomectlError(3, NOT_GRANTED);
  const planned = planProxmox(
    input,
    machine,
    await inventory.providerFor?.(input.host),
  );
  return {
    base: {
      client: client.id,
      ...(input.task ? { task: input.task } : {}),
      host: input.host,
      argv: planned.argv,
      impact: planned.impact,
      classification: planned.classification,
      sudo: false,
      risk: planned.risk,
      machineHash: fingerprint(machine),
      proxmox: planned.request,
      providerHash: planned.providerHash,
      ownerOnly: planned.ownerOnly,
      area: planned.area,
    },
    request: {
      client: client.id,
      ...(input.task ? { task: input.task } : {}),
      kind: "proxmox",
      host: input.host,
      argv: planned.argv,
      sudo: false,
      classification: planned.classification,
      risk: planned.risk,
      ...(input.narrative ? { narrative: input.narrative } : {}),
    },
    ...(input.narrative ? { narrative: input.narrative } : {}),
  };
}

// True when the provider has changed since the request was planned. Such an
// operation never runs: the owner must see a fresh plan.
export async function proxmoxChanged(
  inventory: InventoryPort,
  op: Pick<BrokerOperation, "host" | "providerHash">,
): Promise<boolean> {
  if (op.providerHash === undefined) return false;
  const provider = await inventory.providerFor?.(op.host);
  return provider === undefined || fingerprint(provider) !== op.providerHash;
}
