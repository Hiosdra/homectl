// Daemon wiring for workspace mode (homelab #21 §6). Every broker runs the
// client loop, which starts only once the device is linked. A broker that
// configures a server listener also serves the workspace network paths on
// that address, and nothing else.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SnapshotInput } from "../backup";
import { isExcluded } from "../backup/policy";
import type { Broker } from "../broker/engine";
import type { RouteExtension } from "../broker/server";
import type { EventLog } from "../events/log";
import { HomectlError } from "../types";
import { WorkspaceClient } from "./client";
import { WorkspaceServer } from "./server";

export interface WorkspaceConfig {
  server?: { listen: { hostname: string; port: number } };
}

export interface WorkspaceWiringOptions {
  state: string;
  inventoryPath: string;
  broker: Pick<Broker, "pending" | "decide">;
  log: Pick<EventLog, "since">;
  vaultUnlocked?: () => boolean;
  config?: WorkspaceConfig;
}

export interface WorkspaceWiring {
  extensions: RouteExtension[];
  stop(): Promise<void>;
}

// Requests are small. Only a message can carry a 2 MiB chunk (sealed, then
// base64 twice), and the action is inside the envelope, so the limit applies
// to every message.
const REQUEST_LIMIT = 1024 * 1024;
const MESSAGE_LIMIT = 4 * 1024 * 1024;
const MESSAGE_PATH = "/v1/workspace/message";

// The files a client backs up: the inventory, its known_hosts and the
// owner's policy. Missing files are skipped; excluded paths are refused.
export async function backupFiles(
  inventoryPath: string,
  state: string,
): Promise<SnapshotInput[]> {
  const sources: [string, string][] = [
    ["inventory.yaml", inventoryPath],
    ["known_hosts", join(dirname(inventoryPath), "known_hosts")],
    ["policy.json", join(state, "policy.json")],
  ];
  const files: SnapshotInput[] = [];
  for (const [path, source] of sources) {
    if (isExcluded(path)) continue;
    const data = await readFile(source).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (data !== undefined) files.push({ path, data: new Uint8Array(data) });
  }
  return files;
}

export async function startWorkspace(
  options: WorkspaceWiringOptions,
): Promise<WorkspaceWiring> {
  const client = new WorkspaceClient(options.state, {
    pending: () => options.broker.pending(),
    decide: (input) => options.broker.decide(input),
    events: { since: (after) => options.log.since(after) },
    backupFiles: () => backupFiles(options.inventoryPath, options.state),
    ...(options.vaultUnlocked ? { vaultUnlocked: options.vaultUnlocked } : {}),
  });
  const extensions: RouteExtension[] = [client];
  let listener: { stop(closeActive?: boolean): void } | undefined;
  const listen = options.config?.server?.listen;
  if (listen) {
    const server = new WorkspaceServer(options.state);
    extensions.push(server);
    listener = Bun.serve({
      hostname: listen.hostname,
      port: listen.port,
      fetch: workspaceFetch(server),
    });
  }
  client.start();
  return {
    extensions,
    async stop() {
      client.stop();
      listener?.stop(true);
    },
  };
}

// Serves POST /v1/workspace/* only. Errors carry a message, never a stack.
export function workspaceFetch(server: Pick<WorkspaceServer, "network">) {
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || !path.startsWith("/v1/workspace/"))
      return reply({ error: { message: "Not found" } }, 404);
    try {
      const body = await readBody(
        req,
        path === MESSAGE_PATH ? MESSAGE_LIMIT : REQUEST_LIMIT,
      );
      const result = await server.network(path, body);
      if (result === undefined)
        return reply({ error: { message: "Not found" } }, 404);
      return reply(result, 200);
    } catch (error) {
      if (error instanceof HomectlError)
        return reply(
          { error: { message: error.message } },
          error.code === 3 ? 403 : 400,
        );
      return reply({ error: { message: "The workspace request failed" } }, 400);
    }
  };
}

// Reads the body with a hard byte limit, so a chunked upload cannot exceed it.
async function readBody(req: Request, limit: number): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? "0") > limit)
    throw new HomectlError(2, "Request too large");
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HomectlError(2, "Request too large");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HomectlError(2, "Body must be JSON");
  }
}

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
