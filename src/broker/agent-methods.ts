// The agent methods of the broker (homelab #21 §4). Every agent surface, the
// HTTP /v1/* routes and the MCP endpoint, reaches the engine through this one
// table, so the checks inside Broker cannot differ between surfaces.
import type { ClientIdentity } from "../control/types";
import { HomectlError } from "../types";
import type { Broker } from "./engine";

export function str(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 200)
    throw new HomectlError(2, `${field} is required`);
  return value;
}

// Returns undefined for a path that is not an engine method.
export async function agentMethod(
  broker: Broker,
  path: string,
  input: Record<string, unknown>,
  client: ClientIdentity,
): Promise<unknown> {
  switch (path) {
    case "/v1/whoami":
      return {
        id: client.id,
        name: client.name,
        scopes: client.scopes,
        hosts: client.hosts,
      };
    case "/v1/exec": {
      const { waitMs, ...rest } = input;
      const view = await broker.exec(client, rest);
      return typeof waitMs === "number" && view.state !== "denied"
        ? broker.wait(client, view.id, waitMs)
        : view;
    }
    case "/v1/status":
      return broker.status(client, str(input.id, "id"));
    case "/v1/list":
      return broker.list(
        client,
        typeof input.limit === "number" ? input.limit : 50,
      );
    case "/v1/wait":
      return broker.wait(
        client,
        str(input.id, "id"),
        typeof input.timeoutMs === "number" ? input.timeoutMs : 60_000,
      );
    case "/v1/cancel":
      return broker.cancel(client, str(input.id, "id"));
    case "/v1/task/open":
      return broker.openTask(client, input);
    case "/v1/task/close":
      return broker.closeTask(client, str(input.id, "id"));
    default:
      return undefined;
  }
}
