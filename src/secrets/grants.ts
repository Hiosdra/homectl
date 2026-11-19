// Saved-secret use grants: which clients may use a saved secret, and on which
// hosts, without a new request. A revoked or cancelled secret can never be
// granted again, and its grant dies with it.

import type { SecretDestination } from "../core/contracts";
import { checkHost } from "./destinations";
import type { SecretUseGrant } from "./types";
import {
  isRecord,
  refusal,
  usageError,
  validateClient,
  validateSecretId,
} from "./validation";

const MAX_GRANT_ENTRIES = 32;
const NOT_USABLE = "secret reference is not usable";

interface Grant {
  clients: Set<string>;
  hosts: Set<string>;
}

function nonEmptyList(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_GRANT_ENTRIES
  )
    throw usageError(`${label} must list 1 to ${MAX_GRANT_ENTRIES} entries`);
  const list: readonly unknown[] = value;
  return list;
}

export class SecretGrants {
  private readonly grants = new Map<string, Grant>();
  private readonly revoked = new Set<string>();
  private readonly knownHost: (host: string) => boolean;

  constructor(knownHost: (host: string) => boolean) {
    this.knownHost = knownHost;
  }

  grant(secretId: string, scope: SecretUseGrant): void {
    const id = validateSecretId(secretId);
    if (this.revoked.has(id)) throw refusal(NOT_USABLE);
    if (!isRecord(scope)) throw usageError("grant scope must be an object");
    const clients = nonEmptyList(scope.clients, "clients").map(validateClient);
    const hosts = nonEmptyList(scope.hosts, "hosts").map((host) =>
      checkHost(host, this.knownHost),
    );
    this.grants.set(id, { clients: new Set(clients), hosts: new Set(hosts) });
  }

  // Only ssh-stdin and target-file destinations carry a host, so only they can
  // be covered. Other destination kinds always need a request.
  covers(
    secretId: string,
    client: string,
    destination: SecretDestination,
  ): boolean {
    const grant = this.grants.get(secretId);
    if (!grant || this.revoked.has(secretId)) return false;
    if (destination.kind !== "ssh-stdin" && destination.kind !== "target-file")
      return false;
    return grant.clients.has(client) && grant.hosts.has(destination.host);
  }

  isRevoked(secretId: string): boolean {
    return this.revoked.has(secretId);
  }

  retire(secretId: string): void {
    this.revoked.add(secretId);
    this.grants.delete(secretId);
  }
}
