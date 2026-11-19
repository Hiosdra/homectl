// The owner panel: a loopback web server that serves the owner app and proxies
// /v1/owner/* to the running broker (homelab #21 F1). It holds no secrets and
// no owner session of its own; the broker's hc_owner cookie does the work.
import { resolve } from "node:path";
import { findEndpoint } from "../../broker/client";
import { bundled } from "../../internal";
import { HomectlError } from "../../types";
import { embeddedOwnerScript } from "../embedded";
import { createOwnerProxy, OWNER_PREFIX } from "./proxy";
import { OWNER_CSS, OWNER_HTML } from "./shell";

export interface OwnerPanelOptions {
  inventoryPath: string;
  port: number;
}

export interface OwnerPanel {
  origin: string;
  port: number;
  stop(): void;
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

export async function buildOwnerScript(): Promise<string> {
  if (bundled) {
    if (embeddedOwnerScript === undefined)
      throw new HomectlError(5, "This build has no embedded owner panel.");
    return embeddedOwnerScript;
  }
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "app.tsx")],
    target: "browser",
    minify: true,
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    throw new HomectlError(5, "The owner panel failed to build");
  }
  const script = await built.outputs[0]?.text();
  if (script === undefined)
    throw new HomectlError(5, "The owner panel failed to build");
  return script;
}

export async function startOwnerPanel(
  options: OwnerPanelOptions,
): Promise<OwnerPanel> {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new HomectlError(2, "Owner panel port must be between 1 and 65535");
  const script = await buildOwnerScript();
  const origin = `http://127.0.0.1:${options.port}`;
  const proxy = createOwnerProxy({
    panelOrigin: origin,
    endpoint: () => findEndpoint(options.inventoryPath),
  });
  const host = `127.0.0.1:${options.port}`;
  const files: Record<string, { body: string; type: string }> = {
    "/": { body: OWNER_HTML, type: "text/html; charset=utf-8" },
    "/index.html": { body: OWNER_HTML, type: "text/html; charset=utf-8" },
    "/owner.js": { body: script, type: "text/javascript; charset=utf-8" },
    "/owner.css": { body: OWNER_CSS, type: "text/css; charset=utf-8" },
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      // Server-sent events stay open; the broker sends heartbeats.
      idleTimeout: 255,
      async fetch(req) {
        // Loopback name only: a rebinding page cannot reach this panel.
        if (req.headers.get("host") !== host)
          return new Response("Unexpected panel host", {
            status: 403,
            headers: SECURITY_HEADERS,
          });
        const url = new URL(req.url);
        if (url.pathname.startsWith(OWNER_PREFIX)) return proxy(req);
        if (req.method === "GET" && url.pathname === "/healthz")
          return Response.json({ ok: true }, { headers: SECURITY_HEADERS });
        const file = files[url.pathname];
        if (req.method !== "GET" || !file)
          return new Response("Not found", {
            status: 404,
            headers: SECURITY_HEADERS,
          });
        return new Response(file.body, {
          headers: { ...SECURITY_HEADERS, "content-type": file.type },
        });
      },
    });
  } catch {
    throw new HomectlError(
      5,
      `Cannot start the owner panel on 127.0.0.1:${options.port}; choose another port with HOMECTL_OWNER_PANEL_PORT.`,
    );
  }
  return {
    origin,
    port: server.port ?? options.port,
    stop: () => server.stop(true),
  };
}
