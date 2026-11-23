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
import type { EventsPort } from "../broker/types";
import type { EventLog } from "../events/log";
import { HomectlError } from "../types";
import { WorkspaceClient } from "./client";
import { fileRestoreTarget } from "./restore-files";
import { readRevocations } from "./revocations";
import { WorkspaceServer } from "./server";

export interface WorkspaceConfig {
  server?: {
    listen: { hostname: string; port: number };
    // Per-client chunk storage limit in bytes; the server default applies when unset.
    quotaBytes?: number;
  };
}

export interface WorkspaceWiringOptions {
  state: string;
  inventoryPath: string;
  broker: Pick<Broker, "pending" | "decide">;
  log: Pick<EventLog, "since" | "append">;
  // The server broker's event port, for live owner events. Unset, the port is
  // built from the log exactly as the daemon's default port is.
  events?: Pick<EventsPort, "emit">;
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
    decide: async (input) => {
      const result = await options.broker.decide(input);
      const accepted =
        input.decision === "deny-once"
          ? result.operation.state === "denied"
          : result.grant !== undefined;
      return {
        accepted,
        ...(result.operation.reason === undefined
          ? {}
          : { reason: result.operation.reason }),
      };
    },
    events: { since: (after) => options.log.since(after) },
    backupFiles: () => backupFiles(options.inventoryPath, options.state),
    restore: fileRestoreTarget(options.inventoryPath, options.state),
    revocations: () =>
      readRevocations(
        join(dirname(options.inventoryPath), "known_hosts"),
        join(options.state, "policy.json"),
      ),
    ...(options.vaultUnlocked ? { vaultUnlocked: options.vaultUnlocked } : {}),
  });
  const extensions: RouteExtension[] = [client];
  let listener: { stop(closeActive?: boolean): void } | undefined;
  const serverConfig = options.config?.server;
  if (serverConfig) {
    const { quotaBytes, listen } = serverConfig;
    const server = new WorkspaceServer(options.state, {
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
      events: options.events ?? logEvents(options.log),
    });
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

// The daemon's default event port: each event is appended to the broker's log.
export function logEvents(
  log: Pick<EventLog, "append">,
): Pick<EventsPort, "emit"> {
  return {
    emit: async (type, subject, audience, data) => {
      await log.append({ type, subject, audience, data });
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

// HOMECTL_WORKSPACE_LISTEN="host:port" turns this broker into the workspace
// server and opens the pairing/sync listener there. Unset: client only.
// HOMECTL_WORKSPACE_QUOTA_MB sets the per-client backup storage limit (whole
// MiB). It applies only to a server; unset means the server default.
export function workspaceFromEnv(
  value = process.env.HOMECTL_WORKSPACE_LISTEN,
  quotaMb = process.env.HOMECTL_WORKSPACE_QUOTA_MB,
): WorkspaceConfig | undefined {
  if (!value) return undefined;
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  const port = Number(match?.[2]);
  if (!match?.[1] || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new HomectlError(
      2,
      "HOMECTL_WORKSPACE_LISTEN must be host:port, e.g. 0.0.0.0:7450",
    );
  const listen = { hostname: match[1].replace(/^\[|\]$/g, ""), port };
  return {
    server: {
      listen,
      ...(quotaMb ? { quotaBytes: quotaFromMb(quotaMb) } : {}),
    },
  };
}

function quotaFromMb(value: string): number {
  const mb = Number(value);
  if (!Number.isInteger(mb) || mb < 1 || mb > 1024 * 1024)
    throw new HomectlError(
      2,
      "HOMECTL_WORKSPACE_QUOTA_MB must be a whole number of MiB from 1 to 1048576",
    );
  return mb * 1024 * 1024;
}
