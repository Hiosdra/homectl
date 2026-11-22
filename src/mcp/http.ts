// MCP over HTTP inside the daemon: POST /mcp, JSON responses (no SSE). The
// server has already authenticated the client token; this route calls the same
// Broker and SecretService methods as /v1/*, with that ClientIdentity, so every
// grant, scope, approval and redaction check runs unchanged.
import { agentMethod } from "../broker/agent-methods";
import type { Broker } from "../broker/engine";
import type { SecretService } from "../broker/secret-service";
import type { RouteExtension } from "../broker/server";
import type { ClientIdentity } from "../control/types";
import { HomectlError } from "../types";
import { handleMessage } from "./rpc";
import type { AgentPort } from "./tools";

export const MCP_PATH = "/mcp";

export interface McpHttpDeps {
  broker: Broker;
  secrets: SecretService;
  // The guided setup's agent reads (/v1/setup/*), answered by the setup routes.
  setup?: RouteExtension;
}

export function inProcessPort(
  deps: McpHttpDeps,
  client: ClientIdentity,
): AgentPort {
  return {
    async call(path, input) {
      const result = path.startsWith("/v1/secret/")
        ? await deps.secrets.agent(path, input, client)
        : path.startsWith("/v1/setup/")
          ? await deps.setup?.agent?.(path, input, client)
          : await agentMethod(deps.broker, path, input, client);
      if (result === undefined) throw new HomectlError(2, "Unknown method");
      return result;
    },
  };
}

export function mcpHttpRoute(deps: McpHttpDeps): RouteExtension {
  return {
    async agent(path, input, client) {
      if (path !== MCP_PATH) return undefined;
      const reply = await handleMessage(input, inProcessPort(deps, client));
      // A notification gets 202 with no body, as the MCP HTTP transport requires.
      return reply === undefined ? new Response(null, { status: 202 }) : reply;
    },
  };
}
