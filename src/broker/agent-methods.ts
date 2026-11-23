// The agent methods of the broker (homelab #21 §4). Every agent surface, the
// HTTP /v1/* routes and the MCP endpoint, reaches the engine through this one
// table, so the checks inside Broker cannot differ between surfaces.
import type { ClientIdentity } from "../control/types";
import { HomectlError } from "../types";
import type { Broker } from "./engine";
import { WAIT_CHUNK_MS } from "./long-wait";

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
    case "/v1/exec":
    case "/v1/proxmox": {
      const { waitMs, ...rest } = input;
      const view =
        path === "/v1/exec"
          ? await broker.exec(client, rest)
          : await broker.proxmox(client, rest);
      return typeof waitMs === "number" && view.state !== "denied"
        ? broker.wait(client, view.id, Math.min(waitMs, WAIT_CHUNK_MS))
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
        // One request waits at most WAIT_CHUNK_MS; callers poll for the rest.
        typeof input.timeoutMs === "number"
          ? Math.min(input.timeoutMs, WAIT_CHUNK_MS)
          : 60_000,
      );
    case "/v1/cancel":
      return broker.cancel(client, str(input.id, "id"));
    // The agent's own check of a finished operation (§7). Recorded once, by
    // the owning client; it never changes the state or the exit status.
    case "/v1/verify":
      return broker.verify(client, str(input.id, "id"), input.verification);
    case "/v1/task/open":
      return broker.openTask(client, input);
    case "/v1/task/close":
      return broker.closeTask(client, str(input.id, "id"));
    default: {
      // Setup requests (0.3 acceptance): one route per kind, owner-approved only.
      const prefix = "/v1/setup/request/";
      if (!path.startsWith(prefix)) return undefined;
      const { waitMs, ...rest } = input;
      const view = await broker.setupRequest(
        client,
        path.slice(prefix.length),
        rest,
      );
      return typeof waitMs === "number" && view.state !== "denied"
        ? broker.wait(client, view.id, Math.min(waitMs, WAIT_CHUNK_MS))
        : view;
    }
  }
}
