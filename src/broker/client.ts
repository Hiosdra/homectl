// Client side of the broker API, used by the CLI and the MCP stdio shim.
// It finds the daemon through the public endpoint file and authenticates with
// the agent's own client token. It never touches credentials or state files.
import { readFile } from "node:fs/promises";
import { HomectlError } from "../types";
import { UNREACHABLE_MESSAGE } from "./long-wait";
import { clientTokenPath, type Endpoint, endpointCandidates } from "./paths";

export async function findEndpoint(
  inventoryPath?: string,
): Promise<Endpoint | undefined> {
  for (const path of endpointCandidates(inventoryPath)) {
    try {
      const endpoint = JSON.parse(await readFile(path, "utf8")) as Endpoint;
      if (endpoint.v === 1 && typeof endpoint.address === "string")
        return endpoint;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

export async function clientToken(): Promise<string | undefined> {
  if (process.env.HOMECTL_TOKEN) return process.env.HOMECTL_TOKEN.trim();
  try {
    return (await readFile(clientTokenPath(), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface CallOptions {
  endpoint: Endpoint;
  // "Bearer <client token>" for agents, "Owner <session>" for owner CLI.
  authorization?: string;
  timeoutMs?: number;
}

export async function callBroker<T>(
  path: string,
  body: Record<string, unknown>,
  options: CallOptions,
): Promise<T> {
  const { endpoint } = options;
  const url =
    endpoint.transport === "unix"
      ? `http://localhost${path}`
      : `${endpoint.address}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.authorization
          ? { authorization: options.authorization }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 660_000),
      ...(endpoint.transport === "unix" ? { unix: endpoint.address } : {}),
    } as RequestInit);
  } catch {
    throw new HomectlError(5, UNREACHABLE_MESSAGE);
  }
  const data = (await response.json().catch(() => ({}))) as {
    error?: { code: number; message: string; details?: unknown };
  };
  if (!response.ok || data.error)
    throw new HomectlError(
      (data.error?.code as 2 | 3 | 4 | 5) ?? 5,
      data.error?.message ?? `Broker request failed (${response.status})`,
      data.error?.details,
    );
  return data as T;
}
