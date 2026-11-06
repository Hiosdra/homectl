import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { healthBody, VERSION } from "./container/health";
import {
  HEARTBEAT_MS,
  LAUNCH_FILE,
  markRunning,
  markStopped,
} from "./container/recovery";
import { fingerprintOf } from "./control/device-key";
import { ControlPlane, controlStateDirectory } from "./control/engine";
import { ControlReplicator } from "./control/replicator";
import { SYNC_INTERVAL_MS, SyncLoop } from "./control/sync-loop";
import { loadInventory, parseInventory, saveInventory } from "./inventory";
import { execute, writeSSHConfig } from "./operations";
import { discovery } from "./peer/discovery";
import { Hub, peerAddress } from "./peer/hub";
import type { Permissions } from "./peer/store";
import type { Choice } from "./peer/sync";
import { privateDirectory, protect } from "./platform";
import { sessionConfig, ttlSeconds } from "./session";
import { createKey, keyReference } from "./session/keys";
import { doctor } from "./setup";
import { HomectlError, type Machine, type Runner } from "./types";
export type ServeOptions = {
  inventoryPath: string;
  configPath: string;
  port?: number;
  peerPort?: number;
  interface?: string;
  discover?: boolean;
  // false (--no-control-sync): no control sync with peers on this device.
  controlSync?: boolean;
  // Test seam: replaces process execution for control-plane runs only.
  controlRunner?: Runner;
  // Test seams: the sync interval, and a replacement for one scheduled round so
  // a test can hold a round in flight.
  syncIntervalMs?: number;
  syncRound?: () => Promise<unknown>;
  // Container mode (docs/homectl-2.0/container-peer.md). "recovered" means the
  // startup checks repaired or flagged something, so health reports degraded.
  container?: { recovered: boolean };
};
const security = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new HomectlError(2, "JSON content type required");
  const text = await request.text();
  if (text.length > 24 * 1024 * 1024)
    throw new HomectlError(2, "Request too large");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new HomectlError(2, "JSON object required");
  return data;
}
// Constant-time comparison of a presented secret with the expected one.
function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: security });
}
function failure(error: unknown) {
  const e =
    error instanceof HomectlError
      ? error
      : new HomectlError(
          2,
          "Invalid request or unavailable resource; details suppressed",
        );
  return response(
    { error: e.message, code: e.code },
    e.code === 3 ? 403 : e.code === 4 ? 409 : e.code === 5 ? 503 : 400,
  );
}
// Control-plane overview for the Approvals view. Read-only, except that the
// audit verification itself is an in-memory check of the journal.
async function controlPanel(
  control: ControlPlane,
  extra: { sync?: unknown; devices?: unknown },
) {
  const [operations, clients, audit] = await Promise.all([
    control.listOperations({ all: true }),
    control.listClients(),
    control.verifyAudit(),
  ]);
  return {
    operations: operations.slice(0, 200),
    clients,
    sync: extra.sync,
    devices: extra.devices,
    oidc: await control.oidcView(),
    audit: {
      ok: audit.ok,
      entries: audit.entries,
      head: audit.head,
      anchored: audit.anchored,
      checkedAt: new Date().toISOString(),
      error: audit.error,
    },
  };
}

// Upper bound for waiting on an in-flight control-sync round during shutdown.
const SHUTDOWN_WAIT_MS = 10_000;

async function settle(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((done) => {
      timer = setTimeout(done, ms);
    }),
  ]);
  clearTimeout(timer);
}

export async function serve(options: ServeOptions) {
  const interfaceIP = options.interface ?? "127.0.0.1";
  if (!isIP(interfaceIP) || interfaceIP === "0.0.0.0" || interfaceIP === "::")
    throw new HomectlError(
      2,
      "Select one explicit LAN interface IP; wildcard binding is refused",
    );
  peerAddress(
    `http://${interfaceIP.includes(":") ? `[${interfaceIP}]` : interfaceIP}:7448`,
  );
  const peerPort = options.peerPort ?? 7448;
  const token = randomBytes(32).toString("base64url");
  const cookie = randomBytes(32).toString("base64url");
  let hub: Hub;
  let control: ControlPlane;
  let replicator: ControlReplicator | undefined;
  let syncLoop: SyncLoop | undefined;
  let controlTimer: ReturnType<typeof setInterval> | undefined;
  let refreshPeers: (() => Promise<void>) | undefined;
  // The round in progress, awaited on shutdown. Stopping is one-way.
  let inFlight: Promise<unknown> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatWrite: Promise<void> | undefined;
  let stopping = false;
  let stopped = false;
  const degradedNow = () =>
    stopping ||
    options.container?.recovered === true ||
    options.controlSync === false;
  let localPort = options.port ?? 7447;
  const js = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "web/app.ts")],
    target: "browser",
    minify: true,
  });
  if (!js.success) throw new HomectlError(5, "Frontend build failed");
  const script = await js.outputs[0]?.text();
  const html = await readFile(
    resolve(import.meta.dir, "web/index.html"),
    "utf8",
  );
  const css = await readFile(resolve(import.meta.dir, "web/style.css"), "utf8");
  const peerServer = (() => {
    try {
      return Bun.serve({
        hostname: interfaceIP,
        port: peerPort,
        maxRequestBodySize: 24 * 1024 * 1024,
        idleTimeout: 120,
        async fetch(req) {
          try {
            const path = new URL(req.url).pathname;
            if (req.method !== "POST")
              return response({ error: "Not found" }, 404);
            const v = await body(req);
            if (!hub) return response({ error: "Starting" }, 503);
            return await hub.serial(async () => {
              if (path.startsWith("/pair/"))
                return response(await hub.pairingRoute(path, v));
              if (path === "/peer/challenge")
                return response(hub.challenge(String(v.id)));
              if (path === "/peer/message")
                return response(
                  await hub.message(v as Parameters<Hub["message"]>[0]),
                );
              return response({ error: "Not found" }, 404);
            });
          } catch (e) {
            return failure(e);
          }
        },
      });
    } catch {
      throw new HomectlError(
        5,
        `Cannot start peer listener on ${interfaceIP}:${peerPort}. Check that the interface exists and the port is free; an existing pair/serve workspace may already be running.`,
      );
    }
  })();
  const actualPeerPort = peerServer.port;
  const address = `http://${interfaceIP.includes(":") ? `[${interfaceIP}]` : interfaceIP}:${actualPeerPort}`;
  try {
    hub = await new Hub(
      options.inventoryPath,
      options.configPath,
      address,
    ).init();
    control = new ControlPlane({
      inventoryPath: options.inventoryPath,
      configPath: options.configPath,
      stateDirectory: controlStateDirectory(options.inventoryPath),
      runner: options.controlRunner,
      fence: (id) => replicator?.fence(id),
      replicaOverlay: (localIds) =>
        replicator?.overlay(localIds) ??
        Promise.resolve({ notes: {}, remote: [] }),
      approverAuthorized: (id, host) =>
        replicator?.approverAuthorized(id, host) ?? false,
      remoteDecision: async (client, req) => {
        if (!replicator)
          throw new HomectlError(5, "Control sync is not running");
        const sent = await replicator.decide(
          client,
          req.operationId,
          req.fingerprint,
          req.decision,
        );
        return {
          operationId: req.operationId,
          forwarded: sent,
        };
      },
    });
    await control.init();
    if (!hub.device) throw new HomectlError(5, "Device key is not loaded");
    replicator = await ControlReplicator.open({
      plane: control,
      stateDirectory: controlStateDirectory(options.inventoryPath),
      self: { id: hub.state.id, name: hub.state.name, key: hub.device },
    });
    // Control sync (the peer receiver, the scheduler and its timer) is one
    // switch: with --no-control-sync, peers get "not running" and no round starts.
    if (options.controlSync !== false) {
      hub.controlExchange = async (_peer, payload) => {
        const known = (payload as { known?: unknown } | null)?.known;
        if (
          !known ||
          typeof known !== "object" ||
          Array.isArray(known) ||
          Object.values(known).some(
            (c) =>
              !c ||
              typeof (c as { seq?: unknown }).seq !== "number" ||
              typeof (c as { hash?: unknown }).hash !== "string",
          )
        )
          throw new HomectlError(2, "Invalid control sync request");
        if (!replicator)
          throw new HomectlError(5, "Control sync is not running");
        return replicator.serve({
          known: known as Record<string, { seq: number; hash: string }>,
        });
      };
      const rep = replicator;
      refreshPeers = async () => syncPeers();
      // Paired peers that grant sync are the only control-sync peers. Forgotten
      // peers are dropped; the replicator never contacts them again.
      const syncPeers = async () => {
        await rep.refreshSelfName(hub.state.name);
        const wanted = new Set<string>();
        for (const [id, peer] of Object.entries(hub.state.peers)) {
          if (!peer.permissions.sync) continue;
          wanted.add(id);
          await rep.addPeer(id, peer.name, peer.signingKey);
        }
        for (const id of rep.peerIds()) if (!wanted.has(id)) rep.removePeer(id);
      };
      syncLoop = new SyncLoop(rep, async (peerId, request) => {
        await syncPeers();
        return (await hub.peerRequest(
          peerId,
          "control-exchange",
          request,
        )) as Awaited<ReturnType<ControlReplicator["serve"]>>;
      });
      await syncPeers();
      const loop = syncLoop;
      // The peer list is refreshed before every round, so the scheduler always
      // sees the current pairings.
      const round = async () => {
        await syncPeers();
        return loop.tick();
      };
      let ticking = false;
      controlTimer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        inFlight = (options.syncRound ? options.syncRound() : round())
          .catch(() => undefined)
          .finally(() => {
            ticking = false;
          });
      }, options.syncIntervalMs ?? SYNC_INTERVAL_MS);
      controlTimer.unref?.();
    }
  } catch (error) {
    peerServer.stop(true);
    throw error instanceof HomectlError
      ? error
      : new HomectlError(
          5,
          "Cannot initialize peer workspace; check inventory and local state permissions",
        );
  }
  let discovered: ReturnType<typeof discovery> | undefined;
  if (
    options.discover !== false &&
    interfaceIP !== "127.0.0.1" &&
    interfaceIP !== "::1"
  )
    try {
      discovered = discovery(
        actualPeerPort ?? peerPort,
        () => Boolean(hub.pair && hub.pair.expiresAt > Date.now()),
        interfaceIP,
      );
    } catch {}
  const localServer = (() => {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: localPort,
        maxRequestBodySize: 24 * 1024 * 1024,
        idleTimeout: 120,
        async fetch(req) {
          try {
            const url = new URL(req.url);
            // Health: unauthenticated, loopback only, status and version only.
            if (req.method === "GET" && url.pathname === "/healthz")
              return response(healthBody(degradedNow()));
            const host = req.headers.get("Host");
            if (
              host !== `127.0.0.1:${localPort}` &&
              host !== `localhost:${localPort}`
            )
              throw new HomectlError(3, "Unexpected panel host");
            if (url.pathname === "/" && req.method === "GET")
              return new Response(html, {
                headers: {
                  ...security,
                  "Content-Type": "text/html; charset=utf-8",
                },
              });
            if (url.pathname === "/app.js" && req.method === "GET")
              return new Response(script, {
                headers: { ...security, "Content-Type": "text/javascript" },
              });
            if (url.pathname === "/style.css" && req.method === "GET")
              return new Response(css, {
                headers: { ...security, "Content-Type": "text/css" },
              });
            const origin = `http://${host}`;
            if (url.pathname === "/api/connect" && req.method === "POST") {
              if (req.headers.get("Origin") !== origin)
                throw new HomectlError(3, "Open the local panel directly");
              const v = await body(req);
              if (!sameSecret(v.token, token))
                throw new HomectlError(3, "Invalid local panel access code");
              const r = response({ connected: true });
              r.headers.set(
                "Set-Cookie",
                `homectl=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
              );
              return r;
            }
            if (
              !req.headers
                .get("Cookie")
                ?.split("; ")
                .some((v) => sameSecret(v, `homectl=${cookie}`))
            )
              throw new HomectlError(3, "Connect to this local panel first");
            if (req.method === "POST" && req.headers.get("Origin") !== origin)
              throw new HomectlError(3, "Cross-origin operation refused");
            if (req.method === "GET" && url.pathname === "/api/state")
              return response({
                ...(await hub.status()),
                peerAddress: address,
                discovery: discovered?.list() ?? {
                  devices: [],
                  error:
                    "Use a manual peer IP when LAN discovery is unavailable",
                },
                pending: [...hub.pending.values()].map((p) => ({
                  id: p.id,
                  peerId: p.peerId,
                  remoteName: hub.state.peers[p.peerId]?.name,
                })),
                address,
              });
            if (req.method === "GET" && url.pathname === "/api/control") {
              // A rename in settings reaches the replicated names on the next read.
              await replicator?.refreshSelfName(hub.state.name);
              return response(
                await controlPanel(control, {
                  sync: syncView(),
                  devices: devicesView(),
                }),
              );
            }
            // Local operator view of sync (the CLI reads this; never peer or MCP).
            if (req.method === "GET" && url.pathname === "/api/control/sync") {
              const view = syncView();
              if (!view)
                throw new HomectlError(5, "Control sync is not running");
              return response(view);
            }
            if (req.method !== "POST")
              return response({ error: "Not found" }, 404);
            const v = await body(req);
            if (url.pathname === "/api/control/handoff")
              return response(await handoff(v));
            if (url.pathname === "/api/control/resolve")
              return response(await resolveConflict(v));
            if (url.pathname === "/api/control/peer")
              return response(await peerRoute(v));
            // Control-plane routes use their own lock and never enter the hub
            // queue: a long SSH run must not block peer requests.
            // The panel is the local operator: it can execute approved work and
            // revoke clients, but it never approves on behalf of a client.
            if (url.pathname === "/api/control/execute")
              return response(
                await control.request(
                  { kind: "local-operator" },
                  {
                    op: "execute",
                    operationId: await control.resolveOperation(
                      String(v.operationId),
                    ),
                  },
                ),
              );
            if (url.pathname === "/api/control/revoke")
              return response(await control.revokeClient(String(v.id)));
            if (url.pathname === "/api/control/audit/verify")
              return response(await control.verifyAudit());
            // Never hold the local mutation queue while waiting for another peer:
            // simultaneous bidirectional sync must not deadlock both queues.
            if (url.pathname === "/api/sync/start")
              return response(await hub.beginSync(String(v.id)));
            if (url.pathname === "/api/sync/apply")
              return response(
                await hub.syncCommit(
                  String(v.id),
                  (v.choices ?? {}) as Record<string, Choice>,
                ),
              );
            if (url.pathname === "/api/peer/request")
              return response(
                await hub.peerRequest(
                  String(v.id),
                  String(v.action),
                  v.payload,
                ),
              );
            return hub.serial(async () => {
              switch (url.pathname) {
                case "/api/pair/open":
                  return response(await hub.openPair());
                case "/api/pair/join":
                  return response(
                    await hub.join(String(v.address), String(v.code)),
                  );
                case "/api/pair/confirm":
                  return response(
                    await hub.confirm(v.permissions as Permissions),
                  );
                case "/api/pair/poll":
                  return response(await hub.pollPair());
                case "/api/pair/cancel":
                  hub.pair?.key?.fill(0);
                  hub.pair = undefined;
                  return response({ cancelled: true });
                case "/api/vault/unlock":
                  return response(
                    await hub.unlock(String(v.password), v.create === true),
                  );
                case "/api/vault/lock":
                  return response(await hub.lock());
                case "/api/peer/permissions":
                  return response(
                    await hub.permissions(
                      String(v.id),
                      v.permissions as Permissions,
                      v.address as string | undefined,
                    ),
                  );
                case "/api/peer/forget":
                  return response(await hub.forget(String(v.id)));
                case "/api/peer/request":
                  return response(
                    await hub.peerRequest(
                      String(v.id),
                      String(v.action),
                      v.payload,
                    ),
                  );
                case "/api/sync/start":
                  return response(await hub.beginSync(String(v.id)));
                case "/api/sync/preview": {
                  const p = hub.pending.get(String(v.id));
                  if (!p) throw new HomectlError(2, "Unknown preview");
                  hub.pending.delete(p.id);
                  return response(await hub.preview(p.peerId, p.records));
                }
                case "/api/sync/apply":
                  return response(
                    await hub.syncCommit(
                      String(v.id),
                      (v.choices ?? {}) as Record<string, Choice>,
                    ),
                  );
                case "/api/sync/cancel":
                  hub.pending.delete(String(v.id));
                  return response({ cancelled: true });
                case "/api/operation/decide":
                  return response(
                    await hub.decideOperation(
                      String(v.id),
                      v.approved === true,
                    ),
                  );
                case "/api/doctor":
                  return response(
                    await doctor(
                      await loadInventory(options.inventoryPath),
                      options.configPath,
                      v.host as string | undefined,
                    ),
                  );
                case "/api/key/create": {
                  const name = String(v.name);
                  const password = String(v.password ?? "");
                  if (!password || password.length > 1024)
                    throw new HomectlError(2, "Enter the local vault password");
                  await hub.lock();
                  const inv = await loadInventory(options.inventoryPath);
                  const created = await createKey(
                    name,
                    inv,
                    options.inventoryPath,
                    async () => password,
                  );
                  await hub.lock();
                  return response({
                    ...created,
                    publicKey: await readFile(created.auth.public_key, "utf8"),
                  });
                }
                case "/api/machine/save": {
                  if (
                    typeof v.name !== "string" ||
                    !/^[a-z][a-z0-9-]{0,62}$/.test(v.name)
                  )
                    throw new HomectlError(2, "Use a lowercase machine name");
                  const inv = await loadInventory(options.inventoryPath);
                  const m = v.machine as Machine;
                  if (!m || m.transport !== "ssh")
                    throw new HomectlError(
                      2,
                      "Panel editing requires an SSH host",
                    );
                  if (!m.auth)
                    m.auth = keyReference(v.name, options.inventoryPath);
                  inv.machines[v.name] = m;
                  parseInventory(JSON.stringify(inv));
                  await saveInventory(options.inventoryPath, inv);
                  await writeSSHConfig(options.configPath, inv.machines);
                  return response({ saved: true });
                }
                case "/api/machine/delete": {
                  const inv = await loadInventory(options.inventoryPath);
                  if (inv.machines[String(v.name)]?.transport === "local")
                    throw new HomectlError(
                      3,
                      "Local host cannot be removed here",
                    );
                  delete inv.machines[String(v.name)];
                  parseInventory(JSON.stringify(inv));
                  await saveInventory(options.inventoryPath, inv);
                  await writeSSHConfig(options.configPath, inv.machines);
                  return response({ removed: true });
                }
                case "/api/exec": {
                  const inv = await loadInventory(options.inventoryPath);
                  const m = inv.machines[String(v.host)];
                  if (
                    !m ||
                    !Array.isArray(v.argv) ||
                    v.argv.some((a) => typeof a !== "string") ||
                    !v.argv.length
                  )
                    throw new HomectlError(
                      2,
                      "Select a machine and command arguments",
                    );
                  // Managed SSH config from the current inventory before any dry run or run.
                  if (v.dryRun !== true)
                    await writeSSHConfig(options.configPath, inv.machines);
                  return response(
                    await execute(String(v.host), m, v.argv as string[], {
                      configPath: options.configPath,
                      dryRun: v.dryRun === true,
                      approval: v.approval as string | undefined,
                      impact: v.impact as string | undefined,
                    }),
                  );
                }
                case "/api/settings": {
                  const inv = await loadInventory(options.inventoryPath);
                  const ttl = String(v.ttl);
                  ttlSeconds(ttl);
                  await hub.lock();
                  inv.session = {
                    ...sessionConfig(inv, options.inventoryPath),
                    ttl,
                  };
                  await saveInventory(options.inventoryPath, inv);
                  if (
                    typeof v.name === "string" &&
                    v.name.trim() &&
                    v.name.length <= 100
                  ) {
                    hub.state.name = v.name;
                    await hub.save();
                  }
                  return response({ saved: true });
                }
                default:
                  return response({ error: "Not found" }, 404);
              }
            });
          } catch (e) {
            return failure(e);
          }
        },
      });
    } catch {
      discovered?.close();
      peerServer.stop(true);
      throw new HomectlError(
        5,
        `Cannot start local panel on 127.0.0.1:${localPort}. Stop the existing pair/serve workspace or choose another --port.`,
      );
    }
  })();
  localPort = localServer.port ?? localPort;
  // Sync status for the local operator: the replicator's view merged with the
  // scheduler's per-peer state (failures, next attempt, last error).
  const isSelf = (nameOrId: string) =>
    nameOrId === hub.state.id || nameOrId === hub.state.name;
  // Sync status for the local operator: the replicator's view merged with the
  // scheduler's per-peer state. With --no-control-sync the view says so.
  const syncView = () => {
    if (!replicator) return undefined;
    const live = new Map((syncLoop?.statuses() ?? []).map((s) => [s.id, s]));
    const status = replicator.status();
    return {
      running: syncLoop !== undefined,
      ...(syncLoop === undefined ? { disabledBy: "--no-control-sync" } : {}),
      intervalMs: SYNC_INTERVAL_MS,
      checkedAt: new Date().toISOString(),
      peers: status.peers.map((peer) => {
        const scheduled = live.get(peer.id);
        return {
          ...peer,
          failures: scheduled?.failures ?? 0,
          nextAttemptAt: scheduled?.nextAttemptAt,
          lastError: scheduled?.lastError,
        };
      }),
      blocked: status.blocked,
      conflicts: status.conflicts,
      resolutions: status.resolutions.map((r) => ({
        ...r,
        waitingForSelf: r.winner === hub.state.id,
      })),
      names: {
        [hub.state.id]: hub.state.name,
        ...Object.fromEntries(
          Object.entries(hub.state.peers).map(([id, peer]) => [id, peer.name]),
        ),
      },
    };
  };
  // Device names and signing fingerprints (fingerprints only, never keys).
  const devicesView = () => ({
    self: {
      id: hub.state.id,
      name: hub.state.name,
      fingerprint: hub.device ? fingerprintOf(hub.device.publicKey) : undefined,
    },
    peers: Object.entries(hub.state.peers).map(([id, peer]) => ({
      id,
      name: peer.name,
      fingerprint: peer.signingKey ? fingerprintOf(peer.signingKey) : undefined,
      legacy: peer.signingKey === undefined,
    })),
  });
  // Local operator handoff. What happens depends on this device's role:
  // the owner offers the operation to a named device (--to DEVICE), the named
  // receiver accepts a pending offer, or a device takes over an unreachable
  // owner. `cancel` withdraws an offer the owner made and nobody accepted.
  const handoff = async (v: {
    operationId?: unknown;
    to?: unknown;
    cancel?: unknown;
  }) => {
    if (!replicator) throw new HomectlError(5, "Control sync is not running");
    const rep = replicator;
    const to = v.to === undefined || v.to === "" ? undefined : String(v.to);
    const operationId = await control.resolveOperation(String(v.operationId));
    // Publish first so a freshly planned operation has its owner recorded.
    await rep.publish();
    if (v.cancel === true) {
      await rep.cancelOffer(operationId);
      return {
        operationId,
        cancelled: true,
        next: "The offer is withdrawn. This device owns the operation again.",
      };
    }
    if (rep.ownerOf(operationId) === hub.state.id) {
      if (to === undefined)
        throw new HomectlError(
          2,
          "Name the device to hand off to with --to DEVICE",
        );
      const offer = await rep.offerHandoff(operationId, to);
      return {
        operationId,
        offered: true,
        to: offer.to,
        next: "This device will not run the operation while the offer is open. The receiving device accepts with the same command on its own device, or the offer is cancelled.",
      };
    }
    if (rep.openOfferTo(operationId)) {
      if (to !== undefined && !isSelf(to))
        throw new HomectlError(
          3,
          `The pending offer names this device; accept it here without --to ${to}.`,
        );
      await rep.acceptOffer(operationId);
      return {
        operationId,
        accepted: true,
        next: "This device owns the operation now. It needs a fresh approval here before it can run.",
      };
    }
    if (to !== undefined && !isSelf(to))
      throw new HomectlError(
        3,
        `A takeover is signed by the device that takes over; run this command on ${to} instead.`,
      );
    await rep.takeover(operationId, "local-operator");
    return {
      operationId,
      taken: true,
      operation: await control.showOperation(operationId),
      next: "This device owns the operation now. It needs a fresh approval here before it can run.",
    };
  };
  // Conflict resolution. A device involved in an ownership conflict proposes a
  // winner (--owner DEVICE). The winner agrees by running the same command on
  // its own device; a winner that proposes itself agrees at once.
  // Suspends a paired device from this device's lease, or resumes it. Local
  // operator only (the panel gate); the decision is signed and replicated.
  const peerRoute = async (v: {
    target?: unknown;
    suspend?: unknown;
    reason?: unknown;
  }) => {
    if (!replicator) throw new HomectlError(5, "Control sync is not running");
    const target = String(v.target ?? "");
    if (!target)
      throw new HomectlError(2, "Name the device to suspend or resume");
    if (v.suspend === true) {
      const done = await replicator.suspendPeer(
        target,
        typeof v.reason === "string" ? v.reason : undefined,
      );
      return {
        suspended: true,
        target: done.target,
        next: "Operations on this device may run without confirming that device has seen the latest state. It rejoins the lease automatically on its next successful sync.",
      };
    }
    const done = await replicator.resumePeer(target);
    return { resumed: true, target: done.target };
  };
  const resolveConflict = async (v: {
    operationId?: unknown;
    owner?: unknown;
  }) => {
    if (!replicator) throw new HomectlError(5, "Control sync is not running");
    const rep = replicator;
    const operationId = await control.resolveOperation(String(v.operationId));
    const owner =
      v.owner === undefined || v.owner === "" ? undefined : String(v.owner);
    if (
      rep.resolutionWaitingFor(operationId) &&
      (owner === undefined || isSelf(owner))
    ) {
      await rep.acceptResolution(operationId);
      return {
        operationId,
        accepted: true,
        next: "This device owns the operation now. It needs a fresh approval here before it can run.",
      };
    }
    if (owner === undefined)
      throw new HomectlError(
        2,
        "Name the device that should own the operation with --owner DEVICE",
      );
    const proposal = await rep.resolveConflict(operationId, owner);
    if (proposal.winner === hub.state.id) {
      await rep.acceptResolution(operationId);
      return {
        operationId,
        accepted: true,
        next: "This device owns the operation now. It needs a fresh approval here before it can run.",
      };
    }
    return {
      operationId,
      proposed: true,
      winner: proposal.winner,
      next: "The resolution applies once the named device runs the same command on its own device.",
    };
  };
  const directory = join(dirname(options.inventoryPath), "serve");
  await privateDirectory(directory);
  const launch = join(directory, LAUNCH_FILE);
  if (options.container) {
    try {
      await markRunning(options.inventoryPath, VERSION);
      // Heartbeat: other instances on this volume refuse while it is fresh.
      heartbeatTimer = setInterval(() => {
        heartbeatWrite = markRunning(options.inventoryPath, VERSION).catch(
          () => undefined,
        );
      }, HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    } catch (error) {
      localServer.stop(true);
      peerServer.stop(true);
      throw error;
    }
  }
  await writeFile(
    launch,
    JSON.stringify({ url: `http://127.0.0.1:${localPort}`, token }),
    { mode: 0o600 },
  );
  await protect(launch);
  return {
    hub,
    control,
    url: `http://127.0.0.1:${localPort}`,
    address,
    launch,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      stopping = true;
      if (controlTimer) clearInterval(controlTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      discovered?.close();
      // Stop sync: let an in-flight round finish, up to a bound.
      if (inFlight) await settle(inFlight, SHUTDOWN_WAIT_MS);
      await hub.lock();
      localServer.stop(true);
      peerServer.stop(true);
      // The launch token dies with the server; the CLI then reports "not running".
      await rm(launch, { force: true }).catch(() => undefined);
      // A heartbeat write already in flight must land before "stopped" is written.
      if (heartbeatWrite) await heartbeatWrite;
      if (options.container)
        await markStopped(options.inventoryPath, VERSION).catch(
          () => undefined,
        );
    },
    localServer,
    peerServer,
    replicator,
    // Runs one control-sync round now (tests and diagnostics).
    syncNow: async () => {
      if (!syncLoop) throw new HomectlError(5, "Control sync is not running");
      await refreshPeers?.();
      return syncLoop.tick({ force: true });
    },
  };
}
