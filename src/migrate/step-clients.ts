// Agent connections (homelab #21 §3). The 0.2 client registry is carried over
// with the same token digests, so agents keep their tokens. Nothing is
// widened: a client never gains a scope or a host grant, a revoked client
// stays revoked, and the retired approve:decide scope is dropped because
// approval is owner-only in 0.3.
import { join } from "node:path";
import { ClientRegistry } from "../control/clients";
import type { ClientRecord, Scope } from "../control/types";
import { HomectlError } from "../types";
import { writeFileAtomic } from "./files";
import type { MigrationContext, MigrationStep } from "./types";

// Scopes that 0.3 no longer grants to agents. Dropped and reported.
export const RETIRED_SCOPES: readonly Scope[] = ["approve:decide"];

export interface Downgrade {
  clients: Record<string, ClientRecord>;
  // Client id and the scope dropped from it.
  dropped: { id: string; scope: Scope }[];
}

function validRecord(id: string, record: ClientRecord): void {
  if (
    !record ||
    !Array.isArray(record.scopes) ||
    !Array.isArray(record.hosts) ||
    typeof record.createdAt !== "number"
  )
    throw new HomectlError(5, `Client record ${id} is malformed`);
}

// Pure: the records 0.3 should carry for a 0.2 registry.
export function downgradeClients(
  source: Record<string, ClientRecord>,
): Downgrade {
  const clients: Record<string, ClientRecord> = {};
  const dropped: Downgrade["dropped"] = [];
  for (const [id, record] of Object.entries(source)) {
    validRecord(id, record);
    const scopes = record.scopes.filter((scope) => {
      if (RETIRED_SCOPES.includes(scope)) {
        dropped.push({ id, scope });
        return false;
      }
      return true;
    });
    clients[id] = structuredClone({ ...record, scopes });
  }
  return { clients, dropped };
}

// Pure: every way the carried registry is wider than, or different from, the
// 0.2 source. Empty when nothing was widened or lost. Messages name client ids
// only, never token digests.
export function broadenedGrants(
  source: Record<string, ClientRecord>,
  carried: Record<string, ClientRecord>,
): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(source))
    if (!(id in carried)) problems.push(`client ${id} was not carried over`);
  for (const [id, record] of Object.entries(carried)) {
    const before = source[id];
    if (!before) {
      problems.push(`client ${id} has no 0.2 record`);
      continue;
    }
    const extraScopes = record.scopes.filter(
      (scope) => !before.scopes.includes(scope),
    );
    if (extraScopes.length)
      problems.push(`client ${id} gained scope(s): ${extraScopes.join(", ")}`);
    if (record.scopes.some((scope) => RETIRED_SCOPES.includes(scope)))
      problems.push(`client ${id} kept a retired scope`);
    const extraHosts = record.hosts.filter(
      (host) => !before.hosts.includes(host),
    );
    if (extraHosts.length) problems.push(`client ${id} gained a host grant`);
    if (record.tokenHash !== before.tokenHash)
      problems.push(`client ${id} changed its token`);
    if (record.createdAt !== before.createdAt)
      problems.push(`client ${id} changed its creation time`);
    if (before.revokedAt !== undefined && record.revokedAt !== before.revokedAt)
      problems.push(`client ${id} lost its revocation`);
  }
  return problems;
}

function sameRecords(
  left: Record<string, ClientRecord>,
  right: Record<string, ClientRecord>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const sourcePath = (context: MigrationContext) =>
  join(context.workspace, "control-plane", "clients.json");
const destinationPath = (context: MigrationContext) =>
  join(context.brokerState, "clients.json");

export const carryAgentClients: MigrationStep = {
  id: "v2-carry-agent-clients",
  from: 2,
  to: 3,
  description:
    "Keep agent connections: copy client records (token digests, scopes, host grants, revocations) into the 0.3 broker, dropping the retired approve:decide scope",
  touches: (context) => [destinationPath(context)],
  async run(context) {
    const source = await new ClientRegistry(sourcePath(context)).load();
    if (Object.keys(source).length === 0) {
      context.note("No 0.2 agent clients to carry over");
      return;
    }
    const { clients, dropped } = downgradeClients(source);
    const existing = await new ClientRegistry(destinationPath(context)).load();
    if (Object.keys(existing).length > 0) {
      if (sameRecords(existing, clients)) return;
      throw new HomectlError(
        5,
        "The 0.3 broker already has client records that differ from 0.2; resolve them before migrating",
      );
    }
    await writeFileAtomic(
      destinationPath(context),
      `${JSON.stringify({ version: 1, clients })}\n`,
    );
    context.note(
      `${Object.keys(clients).length} agent client(s) carried over with their existing tokens`,
    );
    for (const { id, scope } of dropped)
      context.note(
        `Client ${id}: scope ${scope} was dropped; owner approval replaces it. Grant it again only if needed`,
      );
  },
  async verify(context) {
    const source = await new ClientRegistry(sourcePath(context)).load();
    if (Object.keys(source).length === 0) return;
    const carried = await new ClientRegistry(destinationPath(context)).load();
    const problems = broadenedGrants(source, carried);
    if (problems.length)
      throw new HomectlError(
        5,
        `Client carry-over failed verification: ${problems.join("; ")}`,
      );
  },
};
