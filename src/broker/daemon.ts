// Daemon assembly: migrate the workspace, load keys and registries, start the
// engine and the API, publish the endpoint. The daemon is the only process
// that touches credentials and executes commands for agents.
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NonceLedger } from "../approvals/ledger";
import { ClientRegistry } from "../control/clients";
import { fingerprintOf, loadOrCreateDeviceKey } from "../control/device-key";
import { providerEntry } from "../control/proxmox-full";
import { ensurePrivateDirectoryOnce } from "../control/file-lock";
import { EventLog } from "../events";
import { loadInventory } from "../inventory";
import { mcpHttpRoute } from "../mcp/http";
import { migrate } from "../migrate";
import { execute } from "../operations";
import { atomicReplace, privateDirectory } from "../platform";
import { planExecution } from "../policies";
import { SecretBroker } from "../secrets";
import { startWorkspace, type WorkspaceConfig } from "../workspace/wiring";
import type { Runner } from "../types";
import { AssistantSeen } from "./assistant-seen";
import { AuthzPolicy } from "./authz-policy";
import { AiHelperRoutes } from "./ai-helper-routes";
import { AutoModeRoutes } from "./auto-mode-routes";
import { ClientAdmin } from "./clients-admin";
import { Broker } from "./engine";
import { HostKeyRoutes } from "./host-keys";
import { HostPermissionRoutes } from "./host-permissions";
import { OwnerHostRoutes } from "./owner-hosts";
import { FileVerifier, OwnerSessions } from "./owner";
import type { BrokerMode, Endpoint } from "./paths";
import { PolicyRoutes } from "./policy-routes";
import { loadReviewerSettings, reviewerFrom } from "./reviewer-settings";
import { SecretService } from "./secret-service";
import { type Listen, startBrokerServer } from "./server";
import { gatherFacts } from "./setup-facts";
import { machineSummaries } from "./setup-agent";
import { SetupRoutes } from "./setup-routes";
import { isUpgradeNotice, SetupStore } from "./setup-state";
import { proxmoxExecutor } from "./proxmox-exec";
import { ownerSetupPort } from "./setup-exec";
import { BrokerStore } from "./store";
import type {
  EventsPort,
  ExecutorPort,
  InventoryPort,
  PolicyPort,
} from "./types";
import { UpdateRoutes } from "./update-routes";
import type { KeyAgentPort } from "./vault-service";
import { createVault, rebindInventory } from "./vault-wiring";

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
  // Tests: replaces the session ssh-agent the vault loads keys into.
  keyAgent?: KeyAgentPort;
  // Workspace mode: a server listener is opt-in; the client always exists.
  workspace?: WorkspaceConfig;
  // Tests and the browser smoke: the ssh and keyscan runner for machine checks.
  // The default runs the real ssh; nothing in the smoke reaches a real machine.
  machineRunner?: Runner;
}

export function inventoryPort(inventoryPath: string): InventoryPort {
  return {
    machine: async (host) =>
      (await loadInventory(inventoryPath)).machines[host],
    hosts: async () =>
      Object.keys((await loadInventory(inventoryPath)).machines),
    providerFor: async (host) =>
      providerEntry(await loadInventory(inventoryPath), host)?.[1],
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
  // Machines before any migration: an upgrade from 0.2 is one that carried machines.
  const machinesBefore = await loadInventory(config.inventoryPath).then(
    (inventory) => Object.keys(inventory.machines).length,
    () => 0,
  );
  const migration = await migrate(config.inventoryPath, {
    brokerState: config.state,
  });
  await privateDirectory(config.state);
  await ensurePrivateDirectoryOnce(config.state);
  // Setup progress (broker/setup.json). An upgrade that ran just now is shown to the
  // owner once, in plain words, with a note to connect assistants again.
  const setup = new SetupStore(join(config.state, "setup.json"));
  if (isUpgradeNotice(migration, machinesBefore))
    await setup.update((file, at) => {
      file.upgradedAt = at;
      delete file.upgradeAckAt;
    });
  const seen = new AssistantSeen(join(config.state, "assistant-seen.json"));
  const brokerStore = new BrokerStore(config.state);
  const keys = join(config.state, "keys");
  const key = await loadOrCreateDeviceKey(keys);
  // Late-bound: the vault's lock handler needs parts created further down.
  const onLocked: { run: (reason: string) => Promise<void> } = {
    run: async () => undefined,
  };
  const vault = await createVault({
    inventoryPath: config.inventoryPath,
    mode: config.mode,
    now: Date.now,
    ...(config.keyAgent ? { agent: config.keyAgent } : {}),
    onLocked: (reason) => onLocked.run(reason),
  });
  // With a vault, its master password is the owner credential (A3);
  // owner.json is only for workspaces that have no vault yet.
  const hasVault = await vault.exists();
  const verifier = hasVault
    ? vault
    : new FileVerifier(join(config.state, "owner.json"));
  // The AI helper's key: the environment first, then one vault entry (0.3).
  const reviewerKeys = vault.reviewerKeys(hasVault);
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
  const inventory = rebindInventory(
    inventoryPort(config.inventoryPath),
    config.inventoryPath,
  );
  // Setup requests run through the owner routes, which are built further down.
  // The closures run only after startup, so the late binding is safe. The
  // approval already asked for the password (decide checks step-up before any
  // dispatch), so the routes' own step-up is settled here.
  const settled = async () => undefined;
  const executor: ExecutorPort = config.executor ?? {
    ...sshExecutor(config.inventoryPath, config.sshConfigPath),
    proxmox: proxmoxExecutor({ inventoryPath: config.inventoryPath }),
    setup: ownerSetupPort({
      hosts: (path, input) => ownerHosts.owner(path, input, settled),
      policy: (path, input) => policyRoutes.owner(path, input, settled),
    }),
  };
  const hostSet = new Set<string>();
  const refreshHosts = async () => {
    const hosts = await inventory.hosts();
    hostSet.clear();
    for (const host of hosts) hostSet.add(host);
  };
  await refreshHosts();
  const secretBroker = new SecretBroker({
    now: Date.now,
    knownHost: (host) => hostSet.has(host),
  });
  const secrets = new SecretService({
    secrets: secretBroker,
    inventory,
    executor,
    refreshHosts,
    events,
  });
  // The owner's policy file. The engine uses it unless a test injects another.
  // The reviewer is built from the Auto Mode settings on every evaluation;
  // it is consulted only in Auto mode, after the owner's rules.
  const reviewerSettingsPath = join(config.state, "reviewer.json");
  const authz = new AuthzPolicy({
    path: join(config.state, "policy.json"),
    now: Date.now,
    reviewer: async () =>
      reviewerFrom(
        await loadReviewerSettings(reviewerSettingsPath),
        process.env,
        async () => reviewerKeys.read(),
      ),
  });
  const policy = config.policy ?? authz;
  const policyRoutes = new PolicyRoutes(authz);
  const broker = new Broker({
    store: brokerStore,
    ledger: new NonceLedger(config.state),
    key,
    device: {
      id: deviceId,
      name: "this device",
    },
    policy,
    inventory,
    executor,
    events,
    ...(hasVault ? { gate: vault.gate } : {}),
    ...(config.panelOrigin
      ? { approvalSurface: `${config.panelOrigin}/#/approvals` }
      : {}),
  });
  await broker.init();
  if (config.listen.kind === "unix")
    await rm(config.listen.path, { force: true });
  const owner = new OwnerSessions(verifier);
  onLocked.run = async (reason) => {
    secretBroker.lock();
    owner.clear();
    await broker.invalidatePending(reason);
  };
  const registry = new ClientRegistry(join(config.state, "clients.json"));
  const admin = new ClientAdmin(
    registry,
    inventoryPort(config.inventoryPath),
    config.state,
  );
  const workspace = await startWorkspace({
    state: config.state,
    inventoryPath: config.inventoryPath,
    broker,
    log,
    events,
    ...(hasVault ? { vaultUnlocked: () => vault.unlocked() } : {}),
    ...(config.workspace ? { config: config.workspace } : {}),
  });
  const ownerHosts = new OwnerHostRoutes({
    inventoryPath: config.inventoryPath,
    configPath: config.sshConfigPath,
    state: config.state,
    clients: admin,
    runner: config.machineRunner,
    events,
    onInventoryChanged: refreshHosts,
    ...(hasVault
      ? { loadKey: (entry: string) => vault.loadMachineKey(entry) }
      : {}),
  });
  const setupRoutes = new SetupRoutes({
    store: setup,
    machines: async () => machineSummaries((await ownerHosts.list()).machines),
    facts: () =>
      gatherFacts({
        vaultExists: () => vault.exists(),
        machines: () => ownerHosts.readiness(),
        clients: () => admin.list(),
        seen,
        store: brokerStore,
        permissionsRevision: () => authz.revision(),
        state: config.state,
        workspaceServer: config.workspace?.server !== undefined,
      }),
  });
  const running = startBrokerServer({
    broker,
    clients: registry,
    admin,
    owner,
    listen: config.listen,
    allowedOrigins: config.panelOrigin ? [config.panelOrigin] : [],
    extensions: [
      secrets,
      policyRoutes,
      new UpdateRoutes({ events }),
      new AutoModeRoutes({
        store: authz,
        settingsPath: reviewerSettingsPath,
        env: process.env,
        keys: reviewerKeys,
        events,
      }),
      new AiHelperRoutes({
        store: authz,
        settingsPath: reviewerSettingsPath,
        env: process.env,
        keys: reviewerKeys,
        events,
      }),
      mcpHttpRoute({ broker, secrets, setup: setupRoutes }),
      new HostKeyRoutes(
        inventory,
        config.inventoryPath,
        config.machineRunner,
        events,
      ),
      ownerHosts,
      setupRoutes,
      ...workspace.extensions,
      ...(hasVault
        ? [
            vault,
            new HostPermissionRoutes(
              inventory,
              config.inventoryPath,
              config.state,
              vault.gate,
              undefined,
              events,
            ),
          ]
        : []),
    ],
    events: log,
    onAgentSeen: (id) => seen.note(id),
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
    vault,
    async stop() {
      running.stop();
      await workspace.stop();
      await broker.settled();
      // Without a vault the session agent is the owner's legacy one: leave it.
      await vault.shutdown(hasVault);
      await rm(config.endpoint, { force: true });
    },
  };
}
