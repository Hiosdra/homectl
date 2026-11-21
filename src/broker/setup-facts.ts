// Gathers the facts setup detection needs from the broker's own state. Counts and
// booleans only: no key, address, token or secret ever leaves this module.
import type { ClientView } from "../control/types";
import { serverStateFile } from "../workspace/state";
import type { AssistantSeen } from "./assistant-seen";
import type { BrokerStore } from "./store";
import type { SetupFacts } from "./setup-detect";

export interface SetupDeps {
  vaultExists(): Promise<boolean>;
  machines(): Promise<{ enrolled: number; ready: number }>;
  clients(): Promise<ClientView[]>;
  seen: Pick<AssistantSeen, "lastSeen">;
  store: Pick<BrokerStore, "load">;
  permissionsRevision(): Promise<number>;
  // The broker's state directory (the workspace server's state file lives there).
  state: string;
  // Whether this broker was started as a workspace server.
  workspaceServer: boolean;
}

export async function gatherFacts(deps: SetupDeps): Promise<SetupFacts> {
  const [vault, machines, clients, state, revision, server] = await Promise.all(
    [
      deps.vaultExists(),
      deps.machines(),
      deps.clients(),
      deps.store.load(),
      deps.permissionsRevision(),
      serverStateFile(deps.state).read(),
    ],
  );
  const active = clients.filter((client) => !client.revoked);
  let connected = 0;
  for (const client of active)
    if ((await deps.seen.lastSeen(client.id)) !== undefined) connected += 1;
  const operations = Object.values(state.operations);
  const firstAt = operations.length
    ? Math.min(...operations.map((op) => op.createdAt))
    : undefined;
  return {
    vault,
    machines: machines.enrolled,
    readyMachines: machines.ready,
    assistants: active.length,
    connectedAssistants: connected,
    requests: operations.length,
    ...(firstAt === undefined ? {} : { firstRequestAt: firstAt }),
    resolvedApprovals: operations.filter(
      (op) => op.approvedBy !== undefined || op.state === "denied",
    ).length,
    permissionsRevision: revision,
    workspaceServer: deps.workspaceServer,
    pairedDevices: Object.keys(server.clients).length,
  };
}
