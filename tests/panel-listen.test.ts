// The owner panel's bind address (homelab #21 §8). Loopback is the default. A
// non-loopback address opts in, needs its exact origin, and keeps the Host and
// Origin checks strict.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomectlError } from "../src/types";
import {
  nonLoopbackWarning,
  PANEL_INSECURE_HTTP_ENV,
  panelBinding,
  panelOptionsFromEnv,
} from "../src/web/owner/binding";
import { startOwnerPanel } from "../src/web/owner/server";

let dir: string;
let closers: (() => void)[] = [];
let savedEndpoint: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-panel-listen-"));
  closers = [];
  // A broker endpoint that does not exist: the panel must answer as if no broker
  // runs, never reach a real one on this machine.
  savedEndpoint = process.env.HOMECTL_BROKER_ENDPOINT;
  process.env.HOMECTL_BROKER_ENDPOINT = join(dir, "no-endpoint.json");
});

afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  if (savedEndpoint === undefined) delete process.env.HOMECTL_BROKER_ENDPOINT;
  else process.env.HOMECTL_BROKER_ENDPOINT = savedEndpoint;
  await rm(dir, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

test("loopback is the default and needs no origin", () => {
  expect(panelBinding({ port: 7451 })).toEqual({
    hostname: "127.0.0.1",
    origin: "http://127.0.0.1:7451",
    host: "127.0.0.1:7451",
    loopback: true,
  });
});

test("a blank HOMECTL_PANEL_LISTEN counts as unset: loopback", () => {
  expect(panelBinding({ port: 7451, listen: "  " }).loopback).toBe(true);
});

test("IPv6 loopback is answered as a bracketed origin", () => {
  const binding = panelBinding({ port: 7451, listen: "::1" });
  expect(binding.loopback).toBe(true);
  expect(binding.origin).toBe("http://[::1]:7451");
  expect(binding.host).toBe("[::1]:7451");
});

test("a non-loopback address needs HOMECTL_PANEL_ORIGIN, named in the error", () => {
  expect(() => panelBinding({ port: 7451, listen: "0.0.0.0" })).toThrow(
    /HOMECTL_PANEL_ORIGIN/,
  );
  expect(() => panelBinding({ port: 7451, listen: "0.0.0.0" })).toThrow(
    HomectlError,
  );
});

test("a non-loopback address answers as exactly the origin it was given", () => {
  const binding = panelBinding({
    port: 7451,
    listen: "0.0.0.0",
    origin: "http://192.168.1.10:7451/",
    insecureHttp: true,
  });
  expect(binding).toEqual({
    hostname: "0.0.0.0",
    origin: "http://192.168.1.10:7451",
    host: "192.168.1.10:7451",
    loopback: false,
  });
});

test("hostnames and bad addresses are refused, so no name is resolved", () => {
  expect(() => panelBinding({ port: 7451, listen: "localhost" })).toThrow(
    /IP address/,
  );
  expect(() => panelBinding({ port: 7451, listen: "not-an-ip" })).toThrow(
    /IP address/,
  );
});

test("the origin must be an origin only: http or https, no path, query or credentials", () => {
  const refused = [
    "ftp://192.168.1.10:7451",
    "http://192.168.1.10:7451/owner",
    "http://192.168.1.10:7451?x=1",
    "http://user:pass@192.168.1.10:7451",
    "https://homectl.lan.example.test/owner",
    "not a url",
  ];
  for (const origin of refused)
    expect(() =>
      panelBinding({
        port: 7451,
        listen: "0.0.0.0",
        origin,
        insecureHttp: true,
      }),
    ).toThrow(HomectlError);
});

test("a non-loopback plain http origin is refused unless the insecure opt-in is set", () => {
  const origin = "http://192.168.1.10:7451";
  expect(() => panelBinding({ port: 7451, listen: "0.0.0.0", origin })).toThrow(
    HomectlError,
  );
  expect(() =>
    panelBinding({
      port: 7451,
      listen: "0.0.0.0",
      origin,
      insecureHttp: false,
    }),
  ).toThrow(new RegExp(PANEL_INSECURE_HTTP_ENV));
  expect(
    panelBinding({ port: 7451, listen: "0.0.0.0", origin, insecureHttp: true })
      .origin,
  ).toBe(origin);
});

test("a non-loopback https origin needs no insecure opt-in", () => {
  const binding = panelBinding({
    port: 7451,
    listen: "0.0.0.0",
    origin: "https://homectl.lan.example.test",
  });
  expect(binding).toEqual({
    hostname: "0.0.0.0",
    origin: "https://homectl.lan.example.test",
    host: "homectl.lan.example.test",
    loopback: false,
  });
});

test("the insecure opt-in is read from the environment only when it is exactly 1", () => {
  const base = { HOMECTL_PANEL_ORIGIN: "http://192.168.1.10:7451" };
  expect(panelOptionsFromEnv(base).insecureHttp).toBe(false);
  expect(
    panelOptionsFromEnv({ ...base, [PANEL_INSECURE_HTTP_ENV]: "true" })
      .insecureHttp,
  ).toBe(false);
  expect(
    panelOptionsFromEnv({ ...base, [PANEL_INSECURE_HTTP_ENV]: "1" })
      .insecureHttp,
  ).toBe(true);
  expect(panelOptionsFromEnv(base).origin).toBe("http://192.168.1.10:7451");
});

test("the warning names the address and the origin, and asks for trusted controls", () => {
  const warning = nonLoopbackWarning(
    panelBinding({
      port: 7451,
      listen: "0.0.0.0",
      origin: "http://192.168.1.10:7451",
      insecureHttp: true,
    }),
  );
  expect(warning).toContain("0.0.0.0");
  expect(warning).toContain("http://192.168.1.10:7451");
  expect(warning).toContain("trusted network controls");
  // Plain http sends the password and the session cookie unencrypted, in clear
  // text on the LAN, and the warning recommends https or an SSH tunnel.
  expect(warning).toContain("plain http");
  expect(warning).toContain("clear text");
  expect(warning).toContain("SSH tunnel");
});

test("an https origin does not claim the traffic is unencrypted", () => {
  const warning = nonLoopbackWarning(
    panelBinding({
      port: 7451,
      listen: "0.0.0.0",
      origin: "https://homectl.lan.example.test",
    }),
  );
  expect(warning).not.toContain("plain http");
});

test("startOwnerPanel refuses a non-loopback address without an origin, before it builds", async () => {
  await expect(
    startOwnerPanel({
      inventoryPath: join(dir, "inventory.yaml"),
      port: freePort(),
      listen: "0.0.0.0",
      origin: "",
    }),
  ).rejects.toThrow(/HOMECTL_PANEL_ORIGIN/);
});

test("startOwnerPanel refuses a plain http non-loopback origin without the opt-in, and binds nothing", async () => {
  const port = freePort();
  await expect(
    startOwnerPanel({
      inventoryPath: join(dir, "inventory.yaml"),
      port,
      listen: "0.0.0.0",
      origin: `http://127.0.0.1:${port}`,
      insecureHttp: false,
    }),
  ).rejects.toThrow(PANEL_INSECURE_HTTP_ENV);
  // Nothing listens on the port: the refusal came before the server started.
  const probe = await fetch(`http://127.0.0.1:${port}/healthz`).then(
    () => "answered",
    () => "refused",
  );
  expect(probe).toBe("refused");
});

test("a non-loopback panel warns, and keeps the Host and Origin checks strict", async () => {
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const panel = await startOwnerPanel({
    inventoryPath: join(dir, "inventory.yaml"),
    port,
    listen: "0.0.0.0",
    origin,
    insecureHttp: true,
  });
  closers.push(() => {
    panel.stop();
    warn.mockRestore();
  });

  expect(panel.loopback).toBe(false);
  expect(panel.hostname).toBe("0.0.0.0");
  expect(panel.origin).toBe(origin);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("trusted network controls");

  // The panel's own page answers only for the configured Host.
  const health = await fetch(`${origin}/healthz`);
  expect(health.status).toBe(200);
  const forged = await fetch(`${origin}/`, {
    headers: { host: `192.168.1.99:${port}` },
  });
  expect(forged.status).toBe(403);

  // Owner requests from another origin are refused, as on loopback.
  const crossOrigin = await fetch(`${origin}/v1/owner/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://evil.example",
    },
    body: "{}",
  });
  expect(crossOrigin.status).toBe(403);
  expect(await crossOrigin.json()).toMatchObject({
    error: { message: "Owner requests must come from the homectl panel" },
  });

  // From the configured origin the request is forwarded; with no broker running
  // the panel says so.
  const sameOrigin = await fetch(`${origin}/v1/owner/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: "{}",
  });
  expect(sameOrigin.status).toBe(503);
  expect(await sameOrigin.json()).toMatchObject({
    error: { reason: "broker-offline" },
  });
});

test("loopback starts without a warning", async () => {
  const port = freePort();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const panel = await startOwnerPanel({
    inventoryPath: join(dir, "inventory.yaml"),
    port,
    listen: "127.0.0.1",
  });
  closers.push(() => {
    panel.stop();
    warn.mockRestore();
  });
  expect(panel.loopback).toBe(true);
  expect(panel.origin).toBe(`http://127.0.0.1:${port}`);
  expect(warn).not.toHaveBeenCalled();
});
