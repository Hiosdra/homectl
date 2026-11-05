// Minimal MCP server (Streamable HTTP, stateless JSON responses) over the
// control-plane engine. Implemented directly: four tools, three methods plus
// ping and notifications, and no SDK dependency.

import { HomectlError } from "../types";
import { hasScope } from "./clients";
import type { ControlPlane } from "./engine";
import { controlPlaneSchema } from "./schema";
import type { ClientIdentity, OperationKind, Scope } from "./types";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const DEFAULT_MCP_PORT = 7449;
const SERVER_VERSION = "0.1.0";
const MAX_BODY_BYTES = 256 * 1024;
const INSTRUCTIONS =
  "homectl control plane. Propose one exact argv on a granted host with homectl_plan, " +
  "ask a different authorized client to approve the returned fingerprint with homectl_approve, " +
  "then the local operator runs it. Clients cannot execute commands, open shells or read secrets.";

type JsonRecord = Record<string, unknown>;
type ToolName =
  | "homectl_inspect"
  | "homectl_status"
  | "homectl_plan"
  | "homectl_approve";

interface ToolDefinition {
  name: ToolName;
  description: string;
  scope: Scope;
  op: OperationKind;
  inputSchema: JsonRecord;
  readOnly: boolean;
}

// Resolves `$ref` into `definitions` so tool schemas are self-contained.
function inline(node: unknown): unknown {
  const definitions = controlPlaneSchema.definitions as Record<string, unknown>;
  if (Array.isArray(node)) return node.map(inline);
  if (node === null || typeof node !== "object") return node;
  const source = node as JsonRecord;
  if (typeof source.$ref === "string") {
    const name = source.$ref.replace("#/definitions/", "");
    return inline(definitions[name]);
  }
  const out: JsonRecord = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$comment") continue;
    out[key] = inline(value);
  }
  return out;
}

function toolInput(definition: string): JsonRecord {
  const definitions = controlPlaneSchema.definitions as Record<
    string,
    JsonRecord
  >;
  const source = definitions[definition] as {
    properties: JsonRecord;
    required: string[];
  };
  const { op: _op, ...properties } = source.properties;
  return {
    type: "object",
    additionalProperties: false,
    required: source.required.filter((key) => key !== "op"),
    properties: inline(properties),
  };
}

// The complete MCP surface. Nothing else is advertised or callable.
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "homectl_inspect",
    description:
      "Read redacted metadata for granted inventory hosts. Runs no commands and returns no addresses, users or key paths.",
    scope: "inspect:read",
    op: "inspect",
    inputSchema: toolInput("requestInspect"),
    readOnly: true,
  },
  {
    name: "homectl_status",
    description:
      "Read one operation you may see by id, or list recent operations on your granted hosts.",
    scope: "status:read",
    op: "status",
    inputSchema: toolInput("requestStatus"),
    readOnly: true,
  },
  {
    name: "homectl_plan",
    description:
      "Create a pending, fingerprinted plan for one argv on a granted host. Nothing runs until a different authorized client approves the fingerprint and the local operator executes it.",
    scope: "plan:create",
    op: "plan",
    inputSchema: toolInput("requestPlan"),
    readOnly: false,
  },
  {
    name: "homectl_approve",
    description:
      "Approve or reject a pending plan by its exact fingerprint. Approving your own plan is refused.",
    scope: "approve:decide",
    op: "approve",
    inputSchema: toolInput("requestApprove"),
    readOnly: false,
  },
];

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function bearer(header: string | null): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
}

function toolDescriptor(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

async function callTool(
  control: ControlPlane,
  client: ClientIdentity,
  tool: ToolDefinition,
  args: JsonRecord,
) {
  try {
    // `op` is set last so a caller cannot override the typed operation.
    const result = await control.request(
      { kind: "client", client },
      { ...args, op: tool.op },
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    const e =
      error instanceof HomectlError
        ? error
        : new HomectlError(
            5,
            "Control-plane request failed; details suppressed",
          );
    return {
      content: [{ type: "text", text: `${e.message} (code ${e.code})` }],
      isError: true,
    };
  }
}

// JSON-RPC dispatch for one authenticated client. Returns undefined for
// notifications, which get 202 with no body.
async function dispatch(
  control: ControlPlane,
  client: ClientIdentity,
  message: unknown,
): Promise<unknown> {
  if (
    !isRecord(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  )
    return rpcError(null, -32600, "Invalid JSON-RPC request");
  if (!("id" in message)) return undefined;
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number" && id !== null)
    return rpcError(null, -32600, "Invalid JSON-RPC id");
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" &&
        (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "homectl", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.filter((tool) => hasScope(client, tool.scope)).map(
          toolDescriptor,
        ),
      });
    case "tools/call": {
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (!tool) return rpcError(id, -32602, "Unknown tool");
      const args = isRecord(params.arguments) ? params.arguments : {};
      return rpcResult(id, await callTool(control, client, tool, args));
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

export interface McpServer {
  url: string;
  port: number;
  stop(): void;
}

// Starts the endpoint on 127.0.0.1 only. There is no option for another
// address. Host and Origin must name loopback; every request needs a bearer
// token that the control plane authenticates.
export function startMcpServer(options: {
  control: ControlPlane;
  port?: number;
}): McpServer {
  const port = options.port ?? DEFAULT_MCP_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new HomectlError(2, "Port must be 0 through 65535");
  const control = options.control;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: MAX_BODY_BYTES,
      idleTimeout: 30,
      fetch: (request) => handle(request),
    });
  } catch (error) {
    if (
      (error as { code?: string }).code === "EADDRINUSE" ||
      /in use|EADDRINUSE/i.test(String((error as Error).message))
    )
      throw new HomectlError(
        5,
        `Port ${port} is already in use; stop the other process or choose another port with --port`,
      );
    throw new HomectlError(
      5,
      `Cannot start the MCP endpoint on 127.0.0.1:${port}; choose another port`,
    );
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const actual = server.port;
      const url = new URL(request.url);
      if (url.pathname !== "/mcp")
        return reply(404, rpcError(null, -32601, "Not found"));
      const host = request.headers.get("host");
      if (host !== `127.0.0.1:${actual}` && host !== `localhost:${actual}`)
        return reply(403, rpcError(null, -32000, "Unexpected host"));
      const origin = request.headers.get("origin");
      if (
        origin !== null &&
        origin !== `http://127.0.0.1:${actual}` &&
        origin !== `http://localhost:${actual}`
      )
        return reply(403, rpcError(null, -32000, "Unexpected origin"));
      if (request.method !== "POST")
        return reply(405, rpcError(null, -32000, "Use POST"), {
          Allow: "POST",
        });
      const client = await control.authenticate(
        bearer(request.headers.get("authorization")),
      );
      if (!client) {
        await control.recordAuthRejection().catch(() => undefined);
        return reply(401, rpcError(null, -32001, "Unauthorized"), {
          "WWW-Authenticate": 'Bearer realm="homectl"',
        });
      }
      if (
        !request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        return reply(
          400,
          rpcError(null, -32600, "Content-Type must be application/json"),
        );
      let message: unknown;
      try {
        message = JSON.parse(await request.text());
      } catch {
        return reply(400, rpcError(null, -32700, "Parse error"));
      }
      if (Array.isArray(message))
        return reply(
          400,
          rpcError(null, -32600, "Batch requests are not supported"),
        );
      const response = await dispatch(control, client, message);
      if (response === undefined) return new Response(null, { status: 202 });
      return reply(200, response);
    } catch (error) {
      const code =
        error instanceof HomectlError && error.code === 5 ? 503 : 500;
      return reply(code, rpcError(null, -32603, "Internal error"));
    }
  };

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    port: server.port ?? port,
    stop: () => {
      server.stop(true);
    },
  };
}
