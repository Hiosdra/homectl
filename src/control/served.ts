// serve-mcp's view of a running serve. When serve is up it is the single writer:
// every MCP call is forwarded to serve's local routes, which check the bearer
// token against serve's own registry and run the request in serve's plane (with
// its replicator, so approvals for operations owned elsewhere are forwarded).
// Reached through the panel gate (launch token, cookie, Origin and Host checks).
import { localApi } from "../peer/local-api";
import { HomectlError } from "../types";
import type { ControlPlane } from "./engine";
import type { ClientIdentity, ClientView, OperationRequest } from "./types";

// What the MCP layer needs from a control plane.
export type McpControl = Pick<
  ControlPlane,
  | "authenticate"
  | "request"
  | "recordAuthRejection"
  | "oidcView"
  | "listClients"
>;

export class ServedControl implements McpControl {
  // Bearer tokens seen by authenticate(), by client id, for forwarded requests.
  private readonly tokens = new Map<string, string>();

  constructor(private readonly inventoryPath: string) {}

  async authenticate(token?: string): Promise<ClientIdentity | null> {
    if (!token) return null;
    const client = await localApi<ClientIdentity | null>(
      this.inventoryPath,
      "/api/control/mcp/authenticate",
      { token },
    );
    if (!client) return null;
    this.tokens.set(client.id, token);
    return client;
  }

  async request(
    actor: { kind: "client"; client: ClientIdentity },
    req: OperationRequest,
  ): Promise<unknown> {
    const token = this.tokens.get(actor.client.id);
    if (!token) throw new HomectlError(3, "Client authentication is required");
    return localApi(this.inventoryPath, "/api/control/mcp/request", {
      token,
      request: req,
    });
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
