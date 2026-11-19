// serve-mcp's view of a running serve. The legacy MCP endpoint (homelab #21
// B3) only authenticates through a running serve and reads its state. It has no
// request path: planning, approval and execution are not reachable from it.
// Reached through the panel gate (launch token, cookie, Origin and Host checks).
import { localApi } from "../peer/local-api";
import type { ControlPlane } from "./engine";
import type { ClientIdentity, ClientView } from "./types";

// What the legacy MCP layer needs from a control plane: authentication and
// read-only metadata. It never gets a way to act.
export type McpControl = Pick<
  ControlPlane,
  "authenticate" | "recordAuthRejection" | "oidcView" | "listClients"
>;

export class ServedControl implements McpControl {
  constructor(private readonly inventoryPath: string) {}

  async authenticate(token?: string): Promise<ClientIdentity | null> {
    if (!token) return null;
    return localApi<ClientIdentity | null>(
      this.inventoryPath,
      "/api/control/mcp/authenticate",
      { token },
    );
  }

  async recordAuthRejection(): Promise<void> {
    await localApi(this.inventoryPath, "/api/control/mcp/auth-rejection", {});
  }

  async oidcView(): Promise<Awaited<ReturnType<ControlPlane["oidcView"]>>> {
    const panel = await localApi<{
      oidc: Awaited<ReturnType<ControlPlane["oidcView"]>>;
    }>(this.inventoryPath, "/api/control");
    return panel.oidc;
  }

  async listClients(): Promise<ClientView[]> {
    const panel = await localApi<{ clients: ClientView[] }>(
      this.inventoryPath,
      "/api/control",
    );
    return panel.clients;
  }
}
