// Full-mode Proxmox operations for the control plane (inventory operations:
// "full"). A plan is built from the typed API request and the inventory facts in
// force; execution rebuilds it and checks the fingerprint, as catalogue plans do.
// The Proxmox API transport for both catalogue and full plans lives here too.
import { readFile } from "node:fs/promises";
import type { ApiRequest, ApiTarget } from "../proxmox/api";
import { apiRequestFor } from "../proxmox/api";
import { type ProxmoxInput, providerFacts } from "../proxmox/catalogue";
import { fullApiRequest, fullOperation } from "../proxmox/full";
import { apiTokenSecretName } from "../session";
import { HomectlError, type Inventory, type Machine } from "../types";
import { fingerprint } from "./canonical";
import {
  type ApiPlanInput,
  CONTROL_API_VERSION,
  type ExecPlan,
  type OperationRecord,
} from "./types";

type ProviderEntry = [string, NonNullable<Inventory["providers"]>[string]];

export function providerEntry(
  inventory: Inventory,
  host: string,
): ProviderEntry | undefined {
  return Object.entries(inventory.providers ?? {}).find(
    ([, provider]) => provider.host === host,
  );
}

// The plan for one full-mode operation. Refused when the provider is not in full
// mode, the host lacks full access, or the request fails the route checks.
export function buildFullPlan(
  inventory: Inventory,
  host: string,
  machine: Machine,
  input: ApiPlanInput,
): ExecPlan {
  const found = providerEntry(inventory, host);
  if (found === undefined)
    throw new HomectlError(3, "This host is not a configured Proxmox provider");
  if ((found[1].operations ?? "guests") !== "full")
    throw new HomectlError(
      3,
      `Full Proxmox operations are off for ${host}. Set operations: full on its provider in the inventory to allow them.`,
    );
  if (machine.access !== "full")
    throw new HomectlError(3, "Proxmox operations need a full-access host");
  const op = fullOperation(input, providerFacts(found[1]));
  const apiInput: ApiPlanInput = {
    method: op.method,
    path: op.path,
    params: op.params,
  };
  return {
    apiVersion: CONTROL_API_VERSION,
    kind: "exec",
    host,
    machine: structuredClone(machine),
    argv: ["proxmox-api", op.method, op.path],
    impact: op.label,
    classification: op.classification,
    needsApproval: op.classification !== "inspect" || op.ownerOnly,
    execApproval: fingerprint(apiInput),
    apiInput,
    risk: op.risk,
    ...(op.ownerOnly ? { ownerOnly: true } : {}),
  };
}

// Judges a stored full-mode plan by the facts in force now.
export function fullCurrentReason(
  inventory: Inventory,
  op: OperationRecord,
  machine: Machine,
): "ok" | "policy-refused" | "machine-changed" {
  if (op.plan.apiInput === undefined) return "policy-refused";
  try {
    const fresh = buildFullPlan(
      inventory,
      op.plan.host,
      machine,
      op.plan.apiInput,
    );
    return fingerprint(fresh) === op.fingerprint ? "ok" : "machine-changed";
  } catch {
    return "policy-refused";
  }
}

// The API transport for a plan whose provider has an api block: the request is
// derived from the same typed input the approver saw. Catalogue plans use the
// guest request; full-mode plans use the validated route. undefined when the
// plan has no API input and the provider has no api block.
export async function proxmoxTransport(
  inventory: Inventory,
  op: OperationRecord,
  tokenSource: (name: string) => Promise<string | undefined>,
): Promise<
  { request: ApiRequest; target: ApiTarget; node: string } | undefined
> {
  const found = providerEntry(inventory, op.plan.host);
  const input = op.plan.apiInput;
  if (found === undefined || found[1].api === undefined) {
    if (input !== undefined)
      throw new HomectlError(
        3,
        "Full Proxmox operations need the provider's api block (url, ca_file, token_entry) in the inventory",
      );
    return undefined;
  }
  const [name, provider] = found;
  const api = provider.api;
  if (api === undefined) return undefined;
  const facts = providerFacts(provider);
  let request: ApiRequest;
  if (input !== undefined) {
    request = fullApiRequest(fullOperation(input, facts));
  } else {
    if (op.plan.catalogueInput === undefined) return undefined;
    request = apiRequestFor(op.plan.catalogueInput as ProxmoxInput, facts);
  }
  const authorization = await tokenSource(apiTokenSecretName(name));
  if (authorization === undefined)
    throw new HomectlError(
      5,
      "Unlock the session first: the Proxmox API token is not loaded. The operation stays approved.",
    );
  const caPem = await readFile(api.ca_file, "utf8");
  return {
    request,
    node: provider.node,
    target: { baseUrl: api.url, caPem, authorization },
  };
}
