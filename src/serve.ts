import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
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
import { HomectlError, type Machine } from "./types";
export type ServeOptions = {
  inventoryPath: string;
  configPath: string;
  port?: number;
  peerPort?: number;
  interface?: string;
  discover?: boolean;
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
  const peerServer = Bun.serve({
    hostname: interfaceIP,
    port: peerPort,
    maxRequestBodySize: 24 * 1024 * 1024,
    idleTimeout: 120,
    async fetch(req) {
      try {
        const path = new URL(req.url).pathname;
        if (req.method !== "POST") return response({ error: "Not found" }, 404);
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
  const actualPeerPort = peerServer.port;
  const address = `http://${interfaceIP.includes(":") ? `[${interfaceIP}]` : interfaceIP}:${actualPeerPort}`;
  hub = await new Hub(
    options.inventoryPath,
    options.configPath,
    address,
  ).init();
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
  const localServer = Bun.serve({
    hostname: "127.0.0.1",
    port: localPort,
    maxRequestBodySize: 24 * 1024 * 1024,
    idleTimeout: 120,
    async fetch(req) {
      try {
        const url = new URL(req.url);
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
          if (v.token !== token)
            throw new HomectlError(3, "Invalid local panel access code");
          const r = response({ connected: true });
          r.headers.set(
            "Set-Cookie",
            `homectl=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
          );
          return r;
        }
        if (
          req.headers
            .get("Cookie")
            ?.split("; ")
            .find((v) => v === `homectl=${cookie}`) === undefined
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
              error: "Use a manual peer IP when LAN discovery is unavailable",
            },
            pending: [...hub.pending.values()].map((p) => ({
              id: p.id,
              peerId: p.peerId,
              remoteName: hub.state.peers[p.peerId]?.name,
            })),
            address,
          });
        if (req.method !== "POST") return response({ error: "Not found" }, 404);
        const v = await body(req);
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
            await hub.peerRequest(String(v.id), String(v.action), v.payload),
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
              return response(await hub.confirm(v.permissions as Permissions));
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
                await hub.decideOperation(String(v.id), v.approved === true),
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
                throw new HomectlError(2, "Panel editing requires an SSH host");
              if (!m.auth) m.auth = keyReference(v.name, options.inventoryPath);
              inv.machines[v.name] = m;
              parseInventory(JSON.stringify(inv));
              await saveInventory(options.inventoryPath, inv);
              await writeSSHConfig(options.configPath, inv.machines);
              return response({ saved: true });
            }
            case "/api/machine/delete": {
              const inv = await loadInventory(options.inventoryPath);
              if (inv.machines[String(v.name)]?.transport === "local")
                throw new HomectlError(3, "Local host cannot be removed here");
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
  localPort = localServer.port ?? localPort;
  const directory = join(dirname(options.inventoryPath), "serve");
  await privateDirectory(directory);
  const launch = join(directory, "panel.json");
  await writeFile(
    launch,
    JSON.stringify({ url: `http://127.0.0.1:${localPort}`, token }),
    { mode: 0o600 },
  );
  await protect(launch);
  return {
    hub,
    url: `http://127.0.0.1:${localPort}`,
    address,
    launch,
    stop: async () => {
      discovered?.close();
      await hub.lock();
      localServer.stop(true);
      peerServer.stop(true);
    },
    localServer,
    peerServer,
  };
}
