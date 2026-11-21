import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv } from "../src/credentials";
import {
  ensureInventory,
  originMissingForListen,
  panelListen,
  panelOrigin,
  supervise,
} from "../docker/entrypoint";
import { brokerAnswers, healthy, panelAnswers } from "../docker/healthcheck";

const entrypoint = join(import.meta.dir, "../docker/entrypoint.ts");
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const undo of cleanup.splice(0)) await undo();
  delete process.env.HOMECTL_BROKER_ENDPOINT;
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-container-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A tiny HTTP server on loopback that answers every request the same way.
function fake(handler: (req: Request) => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanup.push(() => server.stop(true));
  return server.port as number;
}

// A port with nothing listening on it, for "service is down".
async function closedPort() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port as number;
  server.stop(true);
  return port;
}

describe("owner panel origin", () => {
  test("defaults to the panel port on loopback", () => {
    expect(panelOrigin({})).toBe("http://127.0.0.1:7451");
  });

  test("follows HOMECTL_OWNER_PANEL_PORT", () => {
    expect(panelOrigin({ HOMECTL_OWNER_PANEL_PORT: "8123" })).toBe(
      "http://127.0.0.1:8123",
    );
  });

  test("an explicit HOMECTL_PANEL_ORIGIN wins", () => {
    expect(
      panelOrigin({
        HOMECTL_PANEL_ORIGIN: "https://homectl.example.test",
        HOMECTL_OWNER_PANEL_PORT: "8123",
      }),
    ).toBe("https://homectl.example.test");
  });
});

describe("panel listen address in the container", () => {
  test("is loopback when HOMECTL_PANEL_LISTEN is unset or blank", () => {
    expect(panelListen({})).toBe("127.0.0.1");
    expect(panelListen({ HOMECTL_PANEL_LISTEN: "  " })).toBe("127.0.0.1");
    expect(originMissingForListen({})).toBeUndefined();
  });

  test("a non-loopback listen address names the missing origin before anything starts", () => {
    const message = originMissingForListen({ HOMECTL_PANEL_LISTEN: "0.0.0.0" });
    expect(message).toContain("HOMECTL_PANEL_ORIGIN");
    expect(message).toContain("0.0.0.0");
    expect(
      originMissingForListen({
        HOMECTL_PANEL_LISTEN: "0.0.0.0",
        HOMECTL_PANEL_ORIGIN: "  ",
      }),
    ).toContain("HOMECTL_PANEL_ORIGIN");
  });

  test("a non-loopback listen address with an origin passes the check", () => {
    expect(
      originMissingForListen({
        HOMECTL_PANEL_LISTEN: "0.0.0.0",
        HOMECTL_PANEL_ORIGIN: "https://homectl.example.test",
      }),
    ).toBeUndefined();
  });

  test("supervise refuses to start without an origin, and returns 2 before it touches anything", async () => {
    const saved = {
      listen: process.env.HOMECTL_PANEL_LISTEN,
      origin: process.env.HOMECTL_PANEL_ORIGIN,
    };
    const error = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    process.env.HOMECTL_PANEL_LISTEN = "0.0.0.0";
    delete process.env.HOMECTL_PANEL_ORIGIN;
    try {
      expect(await supervise()).toBe(2);
    } finally {
      console.error = error;
      if (saved.listen === undefined) delete process.env.HOMECTL_PANEL_LISTEN;
      else process.env.HOMECTL_PANEL_LISTEN = saved.listen;
      if (saved.origin === undefined) delete process.env.HOMECTL_PANEL_ORIGIN;
      else process.env.HOMECTL_PANEL_ORIGIN = saved.origin;
    }
    expect(messages.join("\n")).toContain("HOMECTL_PANEL_ORIGIN");
  });
});

describe("inventory bootstrap", () => {
  test("creates the empty inventory, owner-only, when it is missing", async () => {
    const dir = await tempDir();
    const path = join(dir, "home", ".config", "homectl", "inventory.yaml");
    expect(await ensureInventory(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("version: 1\nmachines: {}\n");
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("never overwrites an existing inventory", async () => {
    const dir = await tempDir();
    const path = join(dir, "inventory.yaml");
    await writeFile(path, "version: 1\nmachines:\n  keep: {}\n");
    expect(await ensureInventory(path)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(
      "version: 1\nmachines:\n  keep: {}\n",
    );
  });
});

describe("health check", () => {
  test("the broker counts as answering only when it refuses an unauthenticated request", async () => {
    const dir = await tempDir();
    const port = fake((req) => {
      if (new URL(req.url).pathname !== "/v1/whoami")
        return new Response("", { status: 404 });
      return Response.json(
        { error: { code: 3, message: "Client token required" } },
        { status: 401 },
      );
    });
    const endpoint = join(dir, "endpoint.json");
    await writeFile(
      endpoint,
      JSON.stringify({
        v: 1,
        mode: "compat",
        transport: "tcp",
        address: `http://127.0.0.1:${port}`,
        pid: 1,
      }),
    );
    process.env.HOMECTL_BROKER_ENDPOINT = endpoint;
    expect(await brokerAnswers()).toBe(true);
  });

  test("a server that accepts the request without a token is not a healthy broker", async () => {
    const dir = await tempDir();
    const port = fake(() => Response.json({ ok: true }));
    const endpoint = join(dir, "endpoint.json");
    await writeFile(
      endpoint,
      JSON.stringify({
        v: 1,
        mode: "compat",
        transport: "tcp",
        address: `http://127.0.0.1:${port}`,
        pid: 1,
      }),
    );
    process.env.HOMECTL_BROKER_ENDPOINT = endpoint;
    expect(await brokerAnswers()).toBe(false);
  });

  test("the owner panel answers only with ok:true on /healthz", async () => {
    const good = fake(() => Response.json({ ok: true }));
    const bad = fake(() => Response.json({ ok: false }));
    expect(await panelAnswers(good)).toBe(true);
    expect(await panelAnswers(bad)).toBe(false);
    expect(await panelAnswers(await closedPort())).toBe(false);
  });

  test("healthy needs the broker and the owner panel together", async () => {
    const dir = await tempDir();
    const broker = fake(() =>
      Response.json(
        { error: { code: 3, message: "Client token required" } },
        { status: 401 },
      ),
    );
    const endpoint = join(dir, "endpoint.json");
    await writeFile(
      endpoint,
      JSON.stringify({
        v: 1,
        mode: "compat",
        transport: "tcp",
        address: `http://127.0.0.1:${broker}`,
        pid: 1,
      }),
    );
    process.env.HOMECTL_BROKER_ENDPOINT = endpoint;
    const panel = fake(() => Response.json({ ok: true }));
    const legacy = await closedPort();
    expect(
      await healthy({
        HOMECTL_PANEL_PORT: String(legacy),
        HOMECTL_OWNER_PANEL_PORT: String(panel),
      }),
    ).toBe(true);
    expect(
      await healthy({
        HOMECTL_PANEL_PORT: String(legacy),
        HOMECTL_OWNER_PANEL_PORT: String(await closedPort()),
      }),
    ).toBe(false);
  });

  test("the legacy serve health route is accepted on its own", async () => {
    const legacy = fake(() =>
      Response.json({ status: "ok", version: "0.3.0" }),
    );
    expect(
      await healthy({
        HOMECTL_PANEL_PORT: String(legacy),
        HOMECTL_OWNER_PANEL_PORT: String(await closedPort()),
      }),
    ).toBe(true);
  });
});

describe("entrypoint process", () => {
  // Starts the real supervisor with a temporary HOME. A bad listener value makes
  // the broker fail at once; the supervisor must stop the panel and exit with its code.
  test("a failing broker ends the container with its exit code", async () => {
    const home = await tempDir();
    const env = {
      ...cleanEnv(),
      HOME: home,
      USERPROFILE: home,
      HOMECTL_WORKSPACE_LISTEN: "not-an-address",
      HOMECTL_OWNER_PANEL_PORT: String(await closedPort()),
    };
    const child = Bun.spawn([process.execPath, entrypoint], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    expect(code).toBe(2);
    expect(stderr).toContain("HOMECTL_WORKSPACE_LISTEN must be host:port");
    // The inventory was created before the broker ran.
    expect(
      await readFile(
        join(home, ".config", "homectl", "inventory.yaml"),
        "utf8",
      ),
    ).toBe("version: 1\nmachines: {}\n");
  }, 90_000);

  test("arguments run home-ctl instead of the supervisor", async () => {
    const home = await tempDir();
    const child = Bun.spawn([process.execPath, entrypoint, "help", "owner"], {
      env: { ...cleanEnv(), HOME: home, USERPROFILE: home },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(stdout).toContain("scan-host-keys");
  }, 60_000);
});
