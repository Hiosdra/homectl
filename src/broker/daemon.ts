// Daemon assembly: migrate the workspace, load keys and registries, start the
// engine and the API, publish the endpoint. The daemon is the only process
// that touches credentials and executes commands for agents.
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NonceLedger } from "../approvals/ledger";
import { ClientRegistry } from "../control/clients";
import { fingerprintOf, loadOrCreateDeviceKey } from "../control/device-key";
import { ensurePrivateDirectoryOnce } from "../control/file-lock";
import { EventLog } from "../events";
import { loadInventory } from "../inventory";
import { migrate } from "../migrate";
import { execute } from "../operations";
import { atomicReplace, privateDirectory } from "../platform";
import { planExecution } from "../policies";
import { SecretBroker } from "../secrets";
import { AuthzPolicy } from "./authz-policy";
import { ClientAdmin } from "./clients-admin";
import { Broker } from "./engine";
import { FileVerifier, OwnerSessions } from "./owner";
import type { BrokerMode, Endpoint } from "./paths";
import { SecretService } from "./secret-service";
import { type Listen, startBrokerServer } from "./server";
import { BrokerStore } from "./store";
import type {
  EventsPort,
  ExecutorPort,
  InventoryPort,
  PolicyPort,
} from "./types";

export interface DaemonConfig {
  mode: BrokerMode;
  state: string;
  runtime: string;
  endpoint: string;
  listen: Listen;
  inventoryPath: string;
  sshConfigPath: string;
  panelOrigin?: string;
  policy?: PolicyPort;
  events?: EventsPort;
  executor?: ExecutorPort;
}

export function inventoryPort(inventoryPath: string): InventoryPort {
  return {
    machine: async (host) =>
      (await loadInventory(inventoryPath)).machines[host],
    hosts: async () =>
      Object.keys((await loadInventory(inventoryPath)).machines),
  };
}

// Runs an already-authorized operation through the 0.2 transport (managed
// SSH worker, history recording). The legacy digest is computed here, inside
// the trusted daemon; agents never see or supply it.
export function sshExecutor(
  inventoryPath: string,
  configPath: string,
): ExecutorPort {
  return {
    async run({ host, machine, argv, operationId, stdin }) {
      const approval = planExecution(host, machine, argv).approval;
      const { result } = await execute(host, machine, argv, {
        configPath,
        approval,
        approvalContext: "cli",
        ...(stdin === undefined ? {} : { stdin }),
        audit: { inventoryPath, operationId, requester: "broker" },
      });
      return result;
    },
  };
}

export async function startDaemon(config: DaemonConfig) {
  await migrate(config.inventoryPath);
  await privateDirectory(config.state);
  await ensurePrivateDirectoryOnce(config.state);
  const keys = join(config.state, "keys");
  const key = await loadOrCreateDeviceKey(keys);
  const verifier = new FileVerifier(join(config.state, "owner.json"));
  const deviceId = fingerprintOf(key.publicKey).replaceAll(" ", "");
  const log = new EventLog({
    directory: join(config.state, "events"),
    origin: deviceId,
  });
  const events: EventsPort = config.events ?? {
    emit: async (type, subject, audience, data) => {
      await log.append({ type, subject, audience, data });
    },
  };
  const inventory = inventoryPort(config.inventoryPath);
  const executor =
    config.executor ?? sshExecutor(config.inventoryPath, config.sshConfigPath);
  const hostSet = new Set<string>();
  const refreshHosts = async () => {
    const hosts = await inventory.hosts();
    hostSet.clear();
    for (const host of hosts) hostSet.add(host);
  };
  await refreshHosts();
  const secrets = new SecretService({
    secrets: new SecretBroker({
      now: Date.now,
      knownHost: (host) => hostSet.has(host),
    }),
    inventory,
    executor,
    refreshHosts,
    events,
  });
  const broker = new Broker({
    store: new BrokerStore(config.state),
    ledger: new NonceLedger(config.state),
    key,
    device: {
      id: deviceId,
      name: "this device",
    },
    policy:
      config.policy ??
      new AuthzPolicy({
        path: join(config.state, "policy.json"),
        now: Date.now,
      }),
    inventory,
    executor,
    events,
    ...(config.panelOrigin
      ? { approvalSurface: `${config.panelOrigin}/#approvals` }
      : {}),
  });
  await broker.init();
  if (config.listen.kind === "unix")
    await rm(config.listen.path, { force: true });
  const owner = new OwnerSessions(verifier);
  const registry = new ClientRegistry(join(config.state, "clients.json"));
  const admin = new ClientAdmin(
    registry,
    inventoryPort(config.inventoryPath),
    config.state,
  );
  const running = startBrokerServer({
    broker,
    clients: registry,
    admin,
    owner,
    listen: config.listen,
    allowedOrigins: config.panelOrigin ? [config.panelOrigin] : [],
    extensions: [secrets],
    events: log,
  });
  const endpoint: Endpoint = {
    v: 1,
    mode: config.mode,
    transport: config.listen.kind,
    address:
      config.listen.kind === "unix"
        ? config.listen.path
        : `http://127.0.0.1:${running.server.port}`,
    ...(config.panelOrigin ? { panel: config.panelOrigin } : {}),
    pid: process.pid,
  };
  const temp = `${config.endpoint}.${randomUUID()}.tmp`;
  // The endpoint is public by design: it holds no secret.
  await writeFile(temp, JSON.stringify(endpoint), { mode: 0o644, flag: "wx" });
  await atomicReplace(temp, config.endpoint);
  return {
    broker,
    owner,
    verifier,
    admin,
    endpoint,
    async stop() {
      running.stop();
      await broker.settled();
      await rm(config.endpoint, { force: true });
    },
  };
}
