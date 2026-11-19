// Same-origin reverse proxy from the owner panel to the broker's owner routes
// (homelab #21 F1, D8). Only /v1/owner/* is forwarded. The panel's own cookies
// and headers never reach the broker: the only cookie forwarded is the broker
// session cookie hc_owner. Agent routes are never reachable from here.
import type { Endpoint } from "../../broker/paths";

export const OWNER_PREFIX = "/v1/owner/";
const SESSION_COOKIE = "hc_owner";
// Same limit the broker applies to a request body.
const MAX_BODY = 64 * 1024;
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "last-event-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"];
export const BROKER_OFFLINE =
  "The homectl broker is not running. Start it with `home-ctl daemon run`.";

export interface OwnerProxyOptions {
  // The exact panel origin. The broker only accepts this origin for cookies.
  panelOrigin: string;
  // Finds the running broker. Undefined means the broker is not running.
  endpoint(): Promise<Endpoint | undefined>;
}

export function ownerError(
  status: number,
  code: number,
  message: string,
  reason?: string,
): Response {
  return Response.json(
    { error: { code, message, ...(reason ? { reason } : {}) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

// Reads the broker session cookie and nothing else from the Cookie header.
export function sessionCookie(header: string | null): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE && rest.length > 0) return rest.join("=");
  }
  return undefined;
}

function refusedOrigin(req: Request, panelOrigin: string): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== panelOrigin) return true;
  if (req.method === "POST" && origin !== panelOrigin) return true;
  return req.headers.get("sec-fetch-site") === "cross-site";
}

export function createOwnerProxy(
  options: OwnerProxyOptions,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(OWNER_PREFIX))
      return ownerError(404, 2, "Not found");
    if (req.method !== "GET" && req.method !== "POST")
      return ownerError(405, 2, "Use GET or POST");
    if (refusedOrigin(req, options.panelOrigin))
      return ownerError(
        403,
        3,
        "Owner requests must come from the homectl panel",
      );
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return ownerError(400, 2, "Request too large");

    const endpoint = await options.endpoint().catch(() => undefined);
    if (!endpoint) return ownerError(503, 5, BROKER_OFFLINE, "broker-offline");
    if (endpoint.panel !== options.panelOrigin)
      return ownerError(
        503,
        5,
        `The broker does not accept this panel. Start it with HOMECTL_PANEL_ORIGIN=${options.panelOrigin}.`,
        "origin-not-allowed",
      );

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    // The panel is the origin the broker trusts; the browser's own Origin was
    // checked above and is replaced by the exact configured panel origin.
    headers.set("origin", options.panelOrigin);
    const session = sessionCookie(req.headers.get("cookie"));
    if (session) headers.set("cookie", `${SESSION_COOKIE}=${session}`);

    const body = req.method === "POST" ? await req.text() : undefined;
    if (body !== undefined && body.length > MAX_BODY)
      return ownerError(400, 2, "Request too large");
    const base =
      endpoint.transport === "unix" ? "http://localhost" : endpoint.address;
    let upstream: Response;
    try {
      upstream = await fetch(`${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        // A closed browser connection cancels the upstream stream (SSE).
        signal: req.signal,
        ...(endpoint.transport === "unix" ? { unix: endpoint.address } : {}),
      } as RequestInit);
    } catch {
      return ownerError(503, 5, BROKER_OFFLINE, "broker-offline");
    }

    // Streamed as-is: SSE frames reach the browser without buffering.
    const out = new Headers({ "x-content-type-options": "nosniff" });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    if (!out.has("cache-control")) out.set("cache-control", "no-store");
    // Keep every cookie attribute the broker set (HttpOnly, SameSite, Path).
    for (const cookie of upstream.headers.getSetCookie())
      out.append("set-cookie", cookie);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: out,
    });
  };
}
