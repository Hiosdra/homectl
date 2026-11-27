// The Proxmox executor for broker operations. Runs after any required owner
// approval has been consumed (dispatch.ts). It re-checks the provider and the
// route against the facts in force, then sends one request through the same
// transport the control plane uses. Nothing is retried.
import { readFile } from "node:fs/promises";
import { fingerprint } from "../control/canonical";
import { providerEntry } from "../control/proxmox-full";
import { loadInventory } from "../inventory";
import {
  apiRequestFor,
  type ApiFetch,
  type ApiRequest,
  runProxmoxApi,
} from "../proxmox/api";
import { buildProxmoxPlan, providerFacts } from "../proxmox/catalogue";
import { fullApiRequest, fullOperation } from "../proxmox/full";
import { apiTokenSecretName, getSessionSecret } from "../session";
import { HomectlError, type ProcessResult, type Runner } from "../types";
import type { ProxmoxOperationRequest } from "./proxmox-plan";
import { runProxmoxCatalogue } from "./proxmox-ssh";
import { rebindMachine } from "./vault-wiring";

export interface ProxmoxPort {
  run(input: {
    host: string;
    operationId: string;
    request: ProxmoxOperationRequest;
    providerHash?: string;
    machineHash?: string;
    argv?: string[];
  }): Promise<ProcessResult>;
}

export interface ProxmoxExecutorOptions {
  inventoryPath: string;
  sshRunner?: Runner;
  // Test seam: the HTTP client. Production uses fetch.
  fetcher?: ApiFetch;
  // Test seam: where the API token comes from. Production reads the session.
  tokenSource?: (name: string) => Promise<string | undefined>;
  taskTimeoutMs?: number;
  pollMs?: number;
}

// The API request for a stored operation, built from the provider in force now.
// Refusals here fail the operation before any request is sent.
export function requestFor(
  request: ProxmoxOperationRequest,
  provider: NonNullable<ReturnType<typeof providerEntry>>[1],
): ApiRequest {
  const facts = providerFacts(provider);
  if ("catalogue" in request) return apiRequestFor(request.catalogue, facts);
  if ((provider.operations ?? "guests") !== "full")
    throw new HomectlError(
      3,
      "Full Proxmox operations are off for this provider",
    );
  return fullApiRequest(fullOperation(request.api, facts));
}

export function proxmoxExecutor(options: ProxmoxExecutorOptions): ProxmoxPort {
  const tokenSource =
    options.tokenSource ??
    ((name: string) => getSessionSecret(options.inventoryPath, name));
  return {
    async run({ host, request, providerHash, machineHash, argv }) {
      const inventory = await loadInventory(options.inventoryPath);
      const found = providerEntry(inventory, host);
      if (found === undefined)
        throw new HomectlError(
          3,
          "This host is not a configured Proxmox provider",
        );
      const [name, provider] = found;
      if (providerHash !== undefined && fingerprint(provider) !== providerHash)
        throw new HomectlError(
          3,
          "The Proxmox provider changed since approval; submit a new request",
        );
      if ("catalogue" in request && request.transport === "ssh") {
        const configured = inventory.machines[host];
        const machine =
          configured && rebindMachine(configured, options.inventoryPath);
        if (
          !machine ||
          fingerprint(machine) !== machineHash ||
          !providerHash ||
          !argv
        )
          throw new HomectlError(
            3,
            "The approved Proxmox SSH host or command changed",
          );
        return runProxmoxCatalogue(
          options.inventoryPath,
          machine,
          provider,
          request.catalogue,
          argv,
          async () => {
            const fresh = await loadInventory(options.inventoryPath);
            const current = fresh.machines[host];
            if (
              !current ||
              fingerprint(rebindMachine(current, options.inventoryPath)) !==
                machineHash ||
              fingerprint(providerEntry(fresh, host)?.[1] ?? null) !==
                providerHash
            )
              throw new HomectlError(
                3,
                "The Proxmox host or provider changed before execution",
              );
          },
          options.sshRunner,
        );
      }
      const api = provider.api;
      if (api === undefined)
        throw new HomectlError(3, "This Proxmox provider has no api block");
      // Catalogue operations queued before the SSH transport keep their HTTPS
      // transport. If the catalogue now builds a different command, replan it.
      if ("catalogue" in request && argv !== undefined) {
        const current = buildProxmoxPlan(
          request.catalogue,
          providerFacts(provider),
        );
        if (fingerprint(current.argv) !== fingerprint(argv))
          throw new HomectlError(
            3,
            "The Proxmox command changed since approval",
          );
      }
      const apiRequest = requestFor(request, provider);
      const authorization = await tokenSource(apiTokenSecretName(name));
      if (authorization === undefined)
        throw new HomectlError(
          5,
          "Unlock the session first: the Proxmox API token is not loaded",
        );
      const caPem = await readFile(api.ca_file, "utf8");
      return runProxmoxApi(
        {
          baseUrl: api.url,
          caPem,
          authorization,
        },
        provider.node,
        apiRequest,
        {
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(options.taskTimeoutMs === undefined
            ? {}
            : { taskTimeoutMs: options.taskTimeoutMs }),
          ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        },
      );
    },
  };
}
