// Assembles the broker vault from the workspace: which KDBX, which TTLs, and
// how keys reach the 0.2 session agent. Kept apart from daemon.ts so the
// daemon stays a readable list of parts.
import { basename, dirname, join, resolve } from "node:path";
import { loadInventory } from "../inventory";
import { windows } from "../platform";
import {
  lockSession,
  putSessionSecret,
  sessionConfig,
  sessionPaths,
  startSession,
} from "../session";
import { addKey } from "../session/agent";
import { idleSeconds, ttlSeconds } from "../session/config";
import type { Machine } from "../types";
import { type LockReason, VaultSession } from "../vault";
import type { BrokerMode } from "./paths";
import type { InventoryPort } from "./types";
import { type KeyAgentPort, VaultService } from "./vault-service";

export const PRIVILEGED_TTL_MS = 10 * 60_000;
const DEFAULT_TTL_S = 24 * 3600;
const DEFAULT_IDLE_S = 3600;

// The legacy session agent of this workspace.
export function sessionAgent(inventoryPath: string): KeyAgentPort {
  return {
    start: async (inventory) => {
      await startSession(inventory, inventoryPath);
    },
    add: (key, lifetime) =>
      addKey(
        sessionPaths(inventoryPath).socket,
        key,
        windows ? undefined : lifetime,
      ),
    putSecret: (name, value) => putSessionSecret(inventoryPath, name, value),
    clear: async () => {
      await lockSession(inventoryPath);
    },
  };
}

// In hardened mode the workspace was copied into broker custody, so absolute
// paths written by 0.2 (vault, session socket, inventory) point at the
// owner's old workspace. The broker always uses its own.
export async function vaultPathFor(
  inventoryPath: string,
  mode: BrokerMode,
): Promise<string> {
  const inventory = await loadInventory(inventoryPath);
  const configured = sessionConfig(inventory, inventoryPath).database;
  return mode === "hardened"
    ? join(dirname(resolve(inventoryPath)), basename(configured))
    : configured;
}

export function rebindMachine(
  machine: Machine,
  inventoryPath: string,
): Machine {
  if (machine.auth?.type !== "keepassxc") return machine;
  const paths = sessionPaths(inventoryPath);
  const name = machine.auth.public_key
    ? basename(machine.auth.public_key)
    : undefined;
  return {
    ...machine,
    auth: {
      ...machine.auth,
      inventory: resolve(inventoryPath),
      socket: paths.socket,
      ...(name ? { public_key: join(paths.keys, name) } : {}),
    },
  };
}

export function rebindInventory(
  port: InventoryPort,
  inventoryPath: string,
): InventoryPort {
  return {
    hosts: () => port.hosts(),
    machine: async (host) => {
      const machine = await port.machine(host);
      return machine && rebindMachine(machine, inventoryPath);
    },
    providerFor: (host) =>
      port.providerFor?.(host) ?? Promise.resolve(undefined),
  };
}

export async function createVault(options: {
  inventoryPath: string;
  mode: BrokerMode;
  now: () => number;
  agent?: KeyAgentPort;
  onLocked: (reason: string, cause: LockReason) => Promise<void>;
}): Promise<VaultService> {
  const inventory = await loadInventory(options.inventoryPath);
  const session = inventory.session;
  const ttl = session?.ttl ? ttlSeconds(session.ttl) : DEFAULT_TTL_S;
  const idle = session?.idle ? idleSeconds(session.idle) : DEFAULT_IDLE_S;
  return new VaultService({
    vaultPath: await vaultPathFor(options.inventoryPath, options.mode),
    inventoryPath: options.inventoryPath,
    session: new VaultSession({
      now: options.now,
      absoluteTtlMs: (ttl ?? DEFAULT_TTL_S) * 1000,
      idleTtlMs: idle * 1000,
      privilegedTtlMs: PRIVILEGED_TTL_MS,
    }),
    agent: options.agent ?? sessionAgent(options.inventoryPath),
    now: options.now,
    onLocked: options.onLocked,
  });
}
