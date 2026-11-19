// Broker HTTP API. Agent routes (/v1/*) authenticate with a client token and
// can only reach agent methods. Owner routes (/v1/owner/*) authenticate with
// an owner session; a cookie-authenticated request must also come from an
// allowed Origin (CSRF). Approving anything that needs step-up requires the
// owner secret again in the same request.
import type { ClientIdentity } from "../control/types";
import { type EventLog, pollHandler, sseHandler } from "../events";
import { HomectlError } from "../types";
import type { ClientAdmin } from "./clients-admin";
import type { Broker } from "./engine";
import type { OwnerSessions } from "./owner";
import type { DecideInput } from "./types";

export const MAX_BODY = 64 * 1024;
const COOKIE = "hc_owner";

export interface ClientAuth {
  authenticate(token: string | undefined): Promise<ClientIdentity | null>;
}

export type Listen =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; hostname: "127.0.0.1"; port: number };

// Extra route groups (secrets, events, vault). Each returns undefined for a
// path it does not own. Owner routes run only after owner authentication.
export interface RouteExtension {
  agent?(
    path: string,
    input: Record<string, unknown>,
    client: ClientIdentity,
  ): Promise<unknown>;
  owner?(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown>;
}

export interface BrokerServerOptions {
  broker: Broker;
  clients: ClientAuth;
  owner: OwnerSessions;
  listen: Listen;
  // Exact origins allowed to use the owner cookie (the panel).
  allowedOrigins: string[];
  admin?: ClientAdmin;
  extensions?: RouteExtension[];
  // Live stream (SSE) and catch-up poll, filtered by audience.
  events?: EventLog;
}

const STATUS: Record<number, number> = { 2: 400, 3: 403, 4: 409, 5: 503 };
const DECISIONS = new Set([
  "approve-once",
  "approve-remember",
  "deny-once",
  "deny-remember",
  "revise",
]);

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function failure(error: unknown) {
  if (error instanceof HomectlError)
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      STATUS[error.code] ?? 400,
    );
  return json({ error: { code: 5, message: "Internal broker error" } }, 500);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) throw new HomectlError(2, "Request too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HomectlError(2, "Request too large");
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HomectlError(2, "Body must be JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HomectlError(2, "Body must be a JSON object");
  return value as Record<string, unknown>;
}

function bearer(req: Request, scheme: string): string | undefined {
  const header = req.headers.get("authorization") ?? "";
  const prefix = `${scheme} `;
  return header.startsWith(prefix)
    ? header.slice(prefix.length).trim()
    : undefined;
}

function cookie(req: Request): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 200)
    throw new HomectlError(2, `${field} is required`);
  return value;
}

export function handler(options: BrokerServerOptions) {
  const { broker, clients, owner } = options;

  async function agent(path: string, req: Request, client: ClientIdentity) {
    const input = await body(req);
    switch (path) {
      case "/v1/whoami":
        return {
          id: client.id,
          name: client.name,
          scopes: client.scopes,
          hosts: client.hosts,
        };
      case "/v1/exec": {
        const { waitMs, ...rest } = input;
        const view = await broker.exec(client, rest);
        return typeof waitMs === "number" && view.state !== "denied"
          ? broker.wait(client, view.id, waitMs)
          : view;
      }
      case "/v1/status":
        return broker.status(client, str(input.id, "id"));
      case "/v1/list":
        return broker.list(
          client,
          typeof input.limit === "number" ? input.limit : 50,
        );
      case "/v1/wait":
        return broker.wait(
          client,
          str(input.id, "id"),
          typeof input.timeoutMs === "number" ? input.timeoutMs : 60_000,
        );
      case "/v1/cancel":
        return broker.cancel(client, str(input.id, "id"));
      case "/v1/task/open":
        return broker.openTask(client, input);
      case "/v1/task/close":
        return broker.closeTask(client, str(input.id, "id"));
      default:
        for (const extension of options.extensions ?? []) {
          const result = await extension.agent?.(path, input, client);
          if (result !== undefined) return result;
        }
        return undefined;
    }
  }

  async function ownerRoute(path: string, req: Request) {
    if (path === "/v1/owner/login") {
      const input = await body(req);
      const surface = req.headers.get("origin") ? "panel" : "cli";
      if (surface === "panel") checkOrigin(req);
      const session = await owner.login(input.password, surface);
      return json(
        {
          token: session.token,
          expiresAt: new Date(session.expiresAt).toISOString(),
        },
        200,
        surface === "panel"
          ? {
              "set-cookie": `${COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/v1/owner; Max-Age=900`,
            }
          : {},
      );
    }
    const viaHeader = bearer(req, "Owner");
    const token = viaHeader ?? cookie(req);
    if (!viaHeader) checkOrigin(req);
    const session = owner.resolve(token);
    if (!session) throw new HomectlError(3, "Owner sign-in required");
    const input = await body(req);
    switch (path) {
      case "/v1/owner/clients/list":
        return json(await requireAdmin().list());
      case "/v1/owner/clients/create":
        await requireStepUp(input.password);
        return json(
          await requireAdmin().create({
            id: input.id,
            name: input.name,
            hosts: input.hosts,
            ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
          }),
        );
      case "/v1/owner/clients/rotate":
        await requireStepUp(input.password);
        return json(await requireAdmin().rotate(str(input.id, "id")));
      case "/v1/owner/clients/revoke":
        return json(await requireAdmin().revoke(str(input.id, "id")));
      case "/v1/owner/logout":
        owner.logout(token);
        return json({ ok: true }, 200, {
          "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/v1/owner; Max-Age=0`,
        });
      case "/v1/owner/pending":
        return json(
          (await broker.pending()).map((op) => ({
            ...op,
            // Requester text is untrusted; the panel renders it as such.
            narrative: op.narrative ? { untrusted: op.narrative } : undefined,
          })),
        );
      case "/v1/owner/decide": {
        const decision = str(input.decision, "decision");
        if (!DECISIONS.has(decision))
          throw new HomectlError(2, "Unknown decision");
        const stepUp =
          input.password !== undefined
            ? await owner.check(input.password)
            : false;
        if (input.password !== undefined && !stepUp)
          throw new HomectlError(3, "Wrong owner password");
        return json(
          await broker.decide({
            operationId: str(input.operationId, "operationId"),
            fingerprint: str(input.fingerprint, "fingerprint"),
            decision: decision as DecideInput["decision"],
            surface: session.surface,
            stepUp,
          }),
        );
      }
      default:
        for (const extension of options.extensions ?? []) {
          const result = await extension.owner?.(path, input, requireStepUp);
          if (result !== undefined) return json(result);
        }
        return json({ error: { code: 2, message: "Not found" } }, 404);
    }
  }

  function requireAdmin(): ClientAdmin {
    if (!options.admin)
      throw new HomectlError(5, "Client management is not available");
    return options.admin;
  }

  // Trust and authority changes need the owner password in the same request.
  async function requireStepUp(password: unknown) {
    if (!(await owner.check(password)))
      throw new HomectlError(3, "Confirm with the owner password");
  }

  function checkOrigin(req: Request) {
    const origin = req.headers.get("origin");
    if (!origin || !options.allowedOrigins.includes(origin))
      throw new HomectlError(
        3,
        "Owner requests must come from the homectl panel",
      );
  }

  // Agents see only events addressed to them; the owner sees everything.
  // EventSource cannot set headers, so the panel relies on the SameSite=Strict
  // cookie, which a cross-site page cannot send; no CORS headers are served.
  const authenticateStream = async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/v1/owner/"))
      return owner.resolve(bearer(req, "Owner") ?? cookie(req))
        ? { owner: true as const }
        : null;
    const client = await clients.authenticate(bearer(req, "Bearer"));
    return client ? { client: client.id } : null;
  };
  const streams = options.events
    ? {
        sse: sseHandler(options.events, { authenticate: authenticateStream }),
        poll: pollHandler(options.events, { authenticate: authenticateStream }),
      }
    : undefined;

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "GET" && streams) {
        if (path === "/v1/events" || path === "/v1/owner/events")
          return await streams.sse(req);
        if (path === "/v1/events/poll" || path === "/v1/owner/events/poll")
          return await streams.poll(req);
      }
      if (req.method !== "POST")
        return json({ error: { code: 2, message: "Use POST" } }, 405);
      if (path.startsWith("/v1/owner/")) return await ownerRoute(path, req);
      // Owner tokens are never accepted on agent routes and vice versa.
      const client = await clients.authenticate(bearer(req, "Bearer"));
      if (!client)
        return json(
          { error: { code: 3, message: "Client token required" } },
          401,
        );
      const result = await agent(path, req, client);
      if (result === undefined)
        return json({ error: { code: 2, message: "Not found" } }, 404);
      return json(result);
    } catch (error) {
      return failure(error);
    }
  };
}

export function startBrokerServer(options: BrokerServerOptions) {
  const fetch = handler(options);
  const server =
    options.listen.kind === "unix"
      ? Bun.serve({ unix: options.listen.path, fetch })
      : Bun.serve({
          hostname: options.listen.hostname,
          port: options.listen.port,
          fetch,
        });
  return {
    server,
    stop: () => server.stop(true),
  };
}
