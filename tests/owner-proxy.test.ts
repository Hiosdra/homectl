// The owner panel's proxy: only /v1/owner/* is forwarded, the panel's own
// cookies never reach the broker, cookie flags survive, SSE streams without
// buffering. Also the B4 checks against a real daemon (Origin refusal, cookie
// flags, no token in URLs).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/broker/daemon";
import type { Endpoint } from "../src/broker/paths";
import { compatPaths } from "../src/broker/paths";
import { createOwnerProxy } from "../src/web/owner/proxy";

const PANEL = "http://127.0.0.1:7449";
const PASSWORD = "owner password for tests";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

let dir: string;
let closers: (() => void | Promise<void>)[] = [];
let seen: Seen[] = [];
let release!: () => void;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-owner-proxy-"));
  seen = [];
  closers = [];
});

afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
  await rm(dir, { recursive: true, force: true });
});

// A stand-in broker: records what the proxy forwards and answers the owner
// routes the proxy cares about. /v1/owner/events holds its second frame until
// the test releases it, so a buffering proxy would never deliver the first.
function fakeBroker(): Endpoint {
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers),
      });
      if (url.pathname === "/v1/owner/login")
        return Response.json(
          { token: "hco_test", expiresAt: "2030-01-01T00:00:00.000Z" },
          {
            headers: {
              "set-cookie":
                "hc_owner=hco_test; HttpOnly; SameSite=Strict; Path=/v1/owner; Max-Age=900",
            },
          },
        );
      if (url.pathname === "/v1/owner/events")
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  "id: a:1\nevent: operation.updated\ndata: {}\n\n",
                ),
              );
              await gate;
              controller.enqueue(
                encoder.encode(
                  "id: a:2\nevent: operation.updated\ndata: {}\n\n",
                ),
              );
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  closers.push(() => server.stop(true));
  return {
    v: 1,
    mode: "compat",
    transport: "tcp",
    address: `http://127.0.0.1:${server.port}`,
    panel: PANEL,
    pid: 0,
  };
}

function proxyTo(endpoint: Endpoint | undefined) {
  return createOwnerProxy({
    panelOrigin: PANEL,
    endpoint: async () => endpoint,
  });
}

function request(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  return new Request(`${PANEL}${path}`, init);
}

test("only /v1/owner routes are forwarded", async () => {
  const proxy = proxyTo(fakeBroker());
  const response = await proxy(
    request("/v1/whoami", { method: "POST", headers: { origin: PANEL } }),
  );
  expect(response.status).toBe(404);
  expect(seen).toHaveLength(0);
});

test("owner POSTs must come from the panel origin", async () => {
  const proxy = proxyTo(fakeBroker());
  const none = await proxy(request("/v1/owner/pending", { method: "POST" }));
  expect(none.status).toBe(403);
  const other = await proxy(
    request("/v1/owner/pending", {
      method: "POST",
      headers: { origin: "http://evil.example" },
    }),
  );
  expect(other.status).toBe(403);
  const crossSite = await proxy(
    request("/v1/owner/pending", {
      method: "POST",
      headers: { origin: PANEL, "sec-fetch-site": "cross-site" },
    }),
  );
  expect(crossSite.status).toBe(403);
  expect(seen).toHaveLength(0);
});

test("only the broker session cookie is forwarded, and origin is the panel", async () => {
  const proxy = proxyTo(fakeBroker());
  const response = await proxy(
    request("/v1/owner/pending", {
      method: "POST",
      headers: {
        origin: PANEL,
        cookie: "theme=dark; hc_owner=hco_abc; hc_unlock=panel-secret",
        authorization: "Bearer hct_agent_token",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(response.status).toBe(200);
  const forwarded = seen.at(-1)?.headers ?? {};
  expect(forwarded.cookie).toBe("hc_owner=hco_abc");
  expect(forwarded.origin).toBe(PANEL);
  expect(forwarded.authorization).toBeUndefined();
});

test("the broker's cookie attributes are kept on sign-in", async () => {
  const proxy = proxyTo(fakeBroker());
  const response = await proxy(
    request("/v1/owner/login", {
      method: "POST",
      headers: { origin: PANEL, "content-type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/v1/owner");
  expect(cookie).toContain("Max-Age=900");
});

test("server-sent events pass through without buffering", async () => {
  const proxy = proxyTo(fakeBroker());
  const response = await proxy(
    request("/v1/owner/events", {
      headers: { "last-event-id": "a:0", cookie: "hc_owner=hco_abc" },
    }),
  );
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(seen.at(-1)?.headers["last-event-id"]).toBe("a:0");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no stream");
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, fail) =>
      setTimeout(() => fail(new Error("first frame was buffered")), 2000),
    ),
  ]);
  expect(decoder.decode(first.value)).toContain("id: a:1");
  release();
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += decoder.decode(chunk.value);
  }
  expect(rest).toContain("id: a:2");
});

test("says what to do when no broker is running", async () => {
  const response = await proxyTo(undefined)(
    request("/v1/owner/pending", {
      method: "POST",
      headers: { origin: PANEL },
    }),
  );
  expect(response.status).toBe(503);
  const body = (await response.json()) as {
    error: { message: string; reason: string };
  };
  expect(body.error.reason).toBe("broker-offline");
  expect(body.error.message).toContain("home-ctl daemon run");
});

test("refuses a broker that was not started for this panel", async () => {
  const endpoint = { ...fakeBroker(), panel: "http://127.0.0.1:9999" };
  const response = await proxyTo(endpoint)(
    request("/v1/owner/pending", {
      method: "POST",
      headers: { origin: PANEL },
    }),
  );
  expect(response.status).toBe(503);
  const body = (await response.json()) as { error: { reason: string } };
  expect(body.error.reason).toBe("origin-not-allowed");
});

test("refuses oversized request bodies", async () => {
  const response = await proxyTo(fakeBroker())(
    request("/v1/owner/pending", {
      method: "POST",
      headers: { origin: PANEL, "content-length": "100000" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(400);
  expect(seen).toHaveLength(0);
});

test("B4 against a real daemon: origin refusal, cookie flags, no token in URLs", async () => {
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(
    inventoryPath,
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n",
  );
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    panelOrigin: PANEL,
    executor: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
  });
  closers.push(daemon.stop);
  await daemon.verifier.set(PASSWORD);
  const proxy = createOwnerProxy({
    panelOrigin: PANEL,
    endpoint: async () => daemon.endpoint,
  });

  // The broker refuses a sign-in from any other origin, directly.
  const direct = await fetch(`${daemon.endpoint.address}/v1/owner/login`, {
    method: "POST",
    headers: {
      origin: "http://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(direct.status).toBe(403);

  // Through the panel: the cookie carries the flags, the body carries the token.
  const login = await proxy(
    request("/v1/owner/login", {
      method: "POST",
      headers: { origin: PANEL, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/^hc_owner=hco_/);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  const { token } = (await login.json()) as { token: string };
  expect(token.startsWith("hco_")).toBe(true);

  // Sessions travel as cookies only: no query string carries a token.
  const pending = await proxy(
    request("/v1/owner/pending", {
      method: "POST",
      headers: { origin: PANEL, cookie: `hc_owner=${token}` },
    }),
  );
  expect(pending.status).toBe(200);
  expect(await pending.json()).toEqual([]);
  const events = await proxy(
    request("/v1/owner/events/poll?after=0", {
      headers: { cookie: `hc_owner=${token}` },
    }),
  );
  expect(events.status).toBe(200);

  // Without a session the owner routes refuse; sign-in is required.
  const anonymous = await proxy(
    request("/v1/owner/pending", {
      method: "POST",
      headers: { origin: PANEL },
    }),
  );
  expect(anonymous.status).toBe(403);

  // Step-up is refused without the password for the policy preset change.
  const noPassword = await proxy(
    request("/v1/owner/policy/preset", {
      method: "POST",
      headers: {
        origin: PANEL,
        cookie: `hc_owner=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ preset: "delegated" }),
    }),
  );
  expect(noPassword.status).toBe(403);
  const wrongPassword = await proxy(
    request("/v1/owner/policy/preset", {
      method: "POST",
      headers: {
        origin: PANEL,
        cookie: `hc_owner=${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        preset: "delegated",
        password: "not the password",
      }),
    }),
  );
  expect(wrongPassword.status).toBe(403);
});
