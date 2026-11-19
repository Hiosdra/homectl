// Where the broker keeps state and how clients find it.
//
// Hardened mode: the daemon runs as a dedicated OS identity and owns a state
// directory the agent's user cannot read. Clients find it through a public
// endpoint file in a world-readable runtime directory.
//   Linux/WSL: state /var/lib/homectl, endpoint /run/homectl/endpoint.json,
//              agent socket /run/homectl/agent.sock (token-authenticated)
//   macOS:     state /Library/Application Support/homectl, endpoint
//              /var/run/homectl/endpoint.json
//   Windows:   state %ProgramData%\homectl\state (ACL: service account +
//              Administrators), endpoint %ProgramData%\homectl\endpoint.json,
//              loopback TCP (token-authenticated)
// Compatibility mode: same OS user as the owner, state under the workspace.
// It is explicitly weaker: any process of that user can read the state.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Listen } from "./server";

export type BrokerMode = "hardened" | "compat";

export interface Endpoint {
  v: 1;
  mode: BrokerMode;
  transport: "unix" | "tcp";
  // Unix socket path, or http://127.0.0.1:<port>
  address: string;
  // Where the owner approves (panel URL), if a panel is running.
  panel?: string;
  pid: number;
}

export function hardenedPaths(platform = process.platform) {
  if (platform === "win32") {
    const base = join(process.env.ProgramData ?? "C:\\ProgramData", "homectl");
    return {
      state: join(base, "state"),
      runtime: base,
      endpoint: join(base, "endpoint.json"),
      listen: { kind: "tcp", hostname: "127.0.0.1", port: 7450 } as Listen,
    };
  }
  const darwin = platform === "darwin";
  const runtime = darwin ? "/var/run/homectl" : "/run/homectl";
  return {
    state: darwin ? "/Library/Application Support/homectl" : "/var/lib/homectl",
    runtime,
    endpoint: join(runtime, "endpoint.json"),
    listen: { kind: "unix", path: join(runtime, "agent.sock") } as Listen,
  };
}

export function compatPaths(
  inventoryPath: string,
  platform = process.platform,
) {
  const base = join(dirname(resolve(inventoryPath)), "broker");
  return {
    state: base,
    runtime: base,
    endpoint: join(base, "endpoint.json"),
    listen: (platform === "win32"
      ? { kind: "tcp", hostname: "127.0.0.1", port: 0 }
      : { kind: "unix", path: join(base, "agent.sock") }) as Listen,
  };
}

// Client discovery order: explicit env, hardened endpoint, compat endpoint.
export function endpointCandidates(inventoryPath?: string): string[] {
  const list: string[] = [];
  if (process.env.HOMECTL_BROKER_ENDPOINT)
    list.push(process.env.HOMECTL_BROKER_ENDPOINT);
  list.push(hardenedPaths().endpoint);
  list.push(
    compatPaths(
      inventoryPath ?? join(homedir(), ".config", "homectl", "inventory.yaml"),
    ).endpoint,
  );
  return list;
}

// The agent's own client token (its identity, not an owner credential).
export function clientTokenPath(home = homedir()): string {
  return join(home, ".config", "homectl", "client-token");
}
