// Owner-only management of agent clients (one identity per agent install).
// Tokens are shown once at creation and stored only as digests.
import { join } from "node:path";
import {
  type ClientRegistry,
  clientView,
  generateToken,
  tokenDigest,
  validateClientInput,
} from "../control/clients";
import { withFileLock } from "../control/file-lock";
import type { ClientRecord, ClientView } from "../control/types";
import { HomectlError } from "../types";
import type { InventoryPort } from "./types";

export const AGENT_DEFAULT_SCOPES = [
  "status:read",
  "inspect:read",
  "plan:create",
];

export class ClientAdmin {
  private readonly lock: string;
  constructor(
    private readonly registry: ClientRegistry,
    private readonly inventory: InventoryPort,
    stateDirectory: string,
    private readonly now: () => number = Date.now,
  ) {
    this.lock = join(stateDirectory, ".clients.lock");
  }

  async list(): Promise<ClientView[]> {
    return Object.values(await this.registry.load()).map(clientView);
  }

  async create(
    input: Record<string, unknown>,
  ): Promise<{ client: ClientView; token: string }> {
    const parsed = validateClientInput({
      scopes: AGENT_DEFAULT_SCOPES,
      ...input,
    });
    const known = new Set(await this.inventory.hosts());
    const unknown = parsed.hosts.filter((h) => !known.has(h));
    if (unknown.length)
      throw new HomectlError(
        2,
        `Unknown inventory host(s): ${unknown.join(", ")}`,
      );
    return withFileLock(this.lock, "Client registry", async () => {
      const clients = await this.registry.load();
      if (Object.hasOwn(clients, parsed.id))
        throw new HomectlError(2, "Client id already exists");
      const token = generateToken();
      const record: ClientRecord = {
        ...parsed,
        tokenHash: tokenDigest(token).toString("hex"),
        createdAt: this.now(),
      };
      clients[parsed.id] = record;
      await this.registry.save(clients);
      return { client: clientView(record), token };
    });
  }

  // Rotation: same identity and grants, new token; the old one stops working.
  async rotate(id: string): Promise<{ client: ClientView; token: string }> {
    return withFileLock(this.lock, "Client registry", async () => {
      const clients = await this.registry.load();
      const record = clients[id];
      if (!record || record.revokedAt !== undefined)
        throw new HomectlError(2, "Unknown or revoked client");
      const token = generateToken();
      record.tokenHash = tokenDigest(token).toString("hex");
      await this.registry.save(clients);
      return { client: clientView(record), token };
    });
  }

  async revoke(id: string): Promise<ClientView> {
    return withFileLock(this.lock, "Client registry", async () => {
      const clients = await this.registry.load();
      const record = clients[id];
      if (!record) throw new HomectlError(2, "Unknown client");
      record.revokedAt ??= this.now();
      await this.registry.save(clients);
      return clientView(record);
    });
  }

  // Removes one machine from every assistant's grants (a removed machine must
  // not stay on an assistant). Returns how many assistants lost it.
  async dropHost(host: string): Promise<number> {
    return withFileLock(this.lock, "Client registry", async () => {
      const clients = await this.registry.load();
      let changed = 0;
      for (const record of Object.values(clients)) {
        if (!record.hosts.includes(host)) continue;
        record.hosts = record.hosts.filter((item) => item !== host);
        changed += 1;
      }
      if (changed > 0) await this.registry.save(clients);
      return changed;
    });
  }
}
