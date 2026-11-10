import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(90_000);

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { LAUNCH_FILE, RUN_FILE } from "../src/container/recovery";
import { serveContainer } from "../src/container/run";
import { serve } from "../src/serve";

const REPO = resolve(import.meta.dir, "..");
const MAIN = join(REPO, "src", "cli", "main.ts");
const panelInterface = Object.values(networkInterfaces())
  .flat()
  .find(
    (address) =>
      address?.family === "IPv4" &&
      !address.internal &&
      !address.address.startsWith("127.") &&
      !address.address.startsWith("169.254."),
  )?.address;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

// Synthetic volume: inventory with one local device, laid out like /data.
async function volume() {
  const root = await mkdtemp(join(tmpdir(), "homectl-container-serve-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  const inventory = join(data, "inventory.yaml");
  await writeFile(
    inventory,
    `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`,
  );
  return { root, inventory, configPath: `${inventory}.ssh_config` };
}

async function readRun(inventory: string) {
  return JSON.parse(
    await readFile(join(inventory, "..", "serve", RUN_FILE), "utf8"),
  ) as { state: string };
}

describe("health route (in process)", () => {
  test("returns only status and version, without authentication or the panel token", async () => {
    const v = await volume();
    const running = await serve({
      inventoryPath: v.inventory,
      configPath: v.configPath,
      port: 0,
      peerPort: 0,
      discover: false,
      container: { recovered: false },
    });
    cleanup.push(() => running.stop());
    const response = await fetch(`${running.url}/healthz`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "version"]);
    expect(body).toEqual({ status: "ok", version: pkg.version });
    const launch = JSON.parse(
      await readFile(join(v.inventory, "..", "serve", LAUNCH_FILE), "utf8"),
    ) as { token: string };
    expect(text).not.toContain(launch.token);
  });

  test("reports degraded after a recovered start", async () => {
    const v = await volume();
    const running = await serve({
      inventoryPath: v.inventory,
      configPath: v.configPath,
      port: 0,
      peerPort: 0,
      discover: false,
      container: { recovered: true },
    });
    cleanup.push(() => running.stop());
    const body = (await (await fetch(`${running.url}/healthz`)).json()) as {
      status: string;
    };
    expect(body.status).toBe("degraded");
  });

  test("stop removes the launch token, marks the run stopped, and is idempotent", async () => {
    const v = await volume();
    const running = await serve({
      inventoryPath: v.inventory,
      configPath: v.configPath,
      port: 0,
      peerPort: 0,
      discover: false,
      container: { recovered: false },
    });
    expect((await readRun(v.inventory)).state).toBe("running");
    await running.stop();
    expect((await readRun(v.inventory)).state).toBe("stopped");
    expect(await Bun.file(running.launch).exists()).toBe(false);
    await running.stop();
  });

  test("outside container mode no run marker is written", async () => {
    const v = await volume();
    const running = await serve({
      inventoryPath: v.inventory,
      configPath: v.configPath,
      port: 0,
      peerPort: 0,
      discover: false,
    });
    cleanup.push(() => running.stop());
    expect(
      await Bun.file(join(v.root, "data", "serve", RUN_FILE)).exists(),
    ).toBe(false);
  });
});

describe("authenticated remote panel proxy", () => {
  async function openPanel(origin: string) {
    const v = await volume();
    const token = "panel-access-code-".padEnd(48, "x");
    const running = await serve({
      inventoryPath: v.inventory,
      configPath: v.configPath,
      interface: "127.0.0.1",
      port: 0,
      peerPort: 0,
      discover: false,
      container: { recovered: false },
      panel: {
        interface: panelInterface as string,
        origin,
        accessToken: token,
      },
    });
    cleanup.push(() => running.stop());
    const panelServer = running.remotePanelServer;
    if (!panelServer) throw new Error("remote panel did not start");
    return {
      base: `http://${panelInterface}:${panelServer.port}`,
      host: new URL(origin).host,
      origin,
      token,
    };
  }

  test.skipIf(!panelInterface)(
    "serves the panel and authenticates only the configured host and origin",
    async () => {
      const panel = await openPanel("http://panel.example.test:17447");
      const page = await fetch(panel.base, {
        headers: { Host: panel.host },
      });
      expect(page.status).toBe(200);
      const html = await page.text();
      // The React panel mounts into #root; its text ships in app.js.
      expect(html).toContain('id="root"');

      const app = await fetch(`${panel.base}/app.js`, {
        headers: { Host: panel.host },
      });
      expect(app.status).toBe(200);
      const appScript = await app.text();
      expect(appScript).toContain("Workspace access code");
      expect(appScript).toContain("HOMECTL_PANEL_TOKEN_FILE");
      expect(appScript).toContain("workspace-origin");
      expect(appScript).toContain("Join a pairing session");
      expect(appScript).toContain("not a container-only IP");
      expect(appScript).toContain("UDP 5353");
      expect(appScript).toContain("TCP 7448");
      expect(appScript).toContain("Custom duration…");
      expect(appScript).toContain("Until this computer restarts");
      expect(appScript).toContain("Approved admin commands");
      expect(appScript).toContain("Choose how to get started");
      expect(appScript).toContain("Vault unlocked");
      expect(appScript).toContain("SSH access is managed separately");

      const wrongHost = await fetch(panel.base, {
        headers: { Host: "attacker.example.test" },
      });
      expect(wrongHost.status).toBe(403);

      const wrongOrigin = await fetch(`${panel.base}/api/connect`, {
        method: "POST",
        headers: {
          Host: panel.host,
          Origin: "http://attacker.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: panel.token }),
      });
      expect(wrongOrigin.status).toBe(403);

      const connected = await fetch(`${panel.base}/api/connect`, {
        method: "POST",
        headers: {
          Host: panel.host,
          Origin: panel.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: panel.token }),
      });
      expect(connected.status).toBe(200);
      const cookie = connected.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Secure");

      const state = await fetch(`${panel.base}/api/state`, {
        headers: { Host: panel.host, Cookie: cookie.split(";")[0] ?? "" },
      });
      expect(state.status).toBe(200);
    },
  );

  test.skipIf(!panelInterface)(
    "marks the remote session cookie Secure for an HTTPS reverse proxy",
    async () => {
      const panel = await openPanel("https://panel.example.test");
      const connected = await fetch(`${panel.base}/api/connect`, {
        method: "POST",
        headers: {
          Host: panel.host,
          Origin: panel.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: panel.token }),
      });
      expect(connected.status).toBe(200);
      expect(connected.headers.get("set-cookie")).toMatch(/; Secure$/);
    },
  );

  test("refuses loopback aliases for the remote panel listener", async () => {
    const v = await volume();
    await expect(
      serve({
        inventoryPath: v.inventory,
        configPath: v.configPath,
        interface: "127.0.0.1",
        port: 0,
        peerPort: 0,
        discover: false,
        panel: {
          interface: "127.0.0.2",
          origin: "http://panel.example.test",
          accessToken: "panel-access-code-".padEnd(48, "x"),
        },
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

// Child processes: the real CLI entry point, with synthetic paths and ports.
function spawnServe(args: string[]) {
  return Bun.spawn([process.execPath, MAIN, "serve", "--container", ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return true;
    await Bun.sleep(100);
  }
  return false;
}

describe("container serve (child process)", () => {
  test("container mode needs an explicit interface (exit 2)", async () => {
    const v = await volume();
    const child = spawnServe(["--inventory", v.inventory]);
    expect(await child.exited).toBe(2);
  });

  test("remote panel options are all required and container-only", async () => {
    const v = await volume();
    const incomplete = spawnServe([
      "--inventory",
      v.inventory,
      "--interface",
      "127.0.0.1",
      "--panel-interface",
      "127.0.0.2",
    ]);
    expect(await incomplete.exited).toBe(2);
    const incompleteStderr = await new Response(incomplete.stderr).text();
    expect(incompleteStderr).toContain(
      "Remote panel needs --panel-interface, --panel-origin and --panel-token-file",
    );

    const notContainer = Bun.spawn(
      [
        process.execPath,
        MAIN,
        "serve",
        "--inventory",
        v.inventory,
        "--interface",
        "127.0.0.1",
        "--panel-interface",
        "127.0.0.2",
        "--panel-origin",
        "http://panel.example.test",
        "--panel-token-file",
        "unused-token-file",
      ],
      {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    expect(await notContainer.exited).toBe(2);
    const notContainerStderr = await new Response(notContainer.stderr).text();
    expect(notContainerStderr).toContain(
      "Remote panel options apply only to serve --container",
    );
  });

  test("a truncated audit journal refuses the start before any listener opens (exit 5)", async () => {
    const v = await volume();
    const control = join(v.root, "data", "control-plane");
    await mkdir(control, { recursive: true });
    await writeFile(
      join(control, "audit.anchor"),
      JSON.stringify({ v: 1, seq: 5, hash: "a".repeat(64) }),
    );
    const child = spawnServe([
      "--inventory",
      v.inventory,
      "--interface",
      "127.0.0.1",
      "--port",
      "0",
      "--peer-port",
      "0",
    ]);
    expect(await child.exited).toBe(5);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("failed startup verification");
    expect(
      await Bun.file(join(v.root, "data", "serve", LAUNCH_FILE)).exists(),
    ).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "SIGTERM: health is ok while running, then a clean exit 0 with no launch token and a stopped run marker",
    async () => {
      const v = await volume();
      const child = spawnServe([
        "--inventory",
        v.inventory,
        "--interface",
        "127.0.0.1",
        "--port",
        "0",
        "--peer-port",
        "0",
      ]);
      const launch = join(v.root, "data", "serve", LAUNCH_FILE);
      try {
        expect(await waitForFile(launch, 60_000)).toBe(true);
        const info = JSON.parse(await readFile(launch, "utf8")) as {
          url: string;
          token: string;
        };
        const token = info.token;
        const health = (await (await fetch(`${info.url}/healthz`)).json()) as {
          status: string;
        };
        expect(health.status).toBe("ok");
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);
        expect(await Bun.file(launch).exists()).toBe(false);
        expect((await readRun(v.inventory)).state).toBe("stopped");
        const stdout = await new Response(child.stdout).text();
        expect(stdout).not.toContain(token);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  );
});

describe("container signal wiring (in process)", () => {
  // Emits the signal on this process and captures process.exit, so the runner
  // survives. Works on Windows, where a parent cannot send SIGTERM to a child.
  test("SIGTERM stops the workspace, removes the token, marks it stopped and exits 0", async () => {
    const v = await volume();
    const before = {
      TERM: process.listeners("SIGTERM"),
      INT: process.listeners("SIGINT"),
    };
    const realExit = process.exit;
    const exited = new Promise<number>((done) => {
      process.exit = ((code?: number) => {
        done(code ?? 0);
        return undefined as never;
      }) as typeof process.exit;
    });
    try {
      const code = await serveContainer({
        inventoryPath: v.inventory,
        configPath: v.configPath,
        interface: "127.0.0.1",
        port: 0,
        peerPort: 0,
      });
      expect(code).toBe(0);
      expect((await readRun(v.inventory)).state).toBe("running");
      process.emit("SIGTERM");
      expect(await exited).toBe(0);
    } finally {
      process.exit = realExit;
      for (const l of process.listeners("SIGTERM"))
        if (!before.TERM.includes(l)) process.off("SIGTERM", l);
      for (const l of process.listeners("SIGINT"))
        if (!before.INT.includes(l)) process.off("SIGINT", l);
    }
    expect((await readRun(v.inventory)).state).toBe("stopped");
    expect(
      await Bun.file(join(v.root, "data", "serve", LAUNCH_FILE)).exists(),
    ).toBe(false);
  });
});

describe("stop and an in-flight sync round", () => {
  // The round is replaced by a synthetic slow one; the interval is shortened so
  // a round starts within the test. No peer is contacted.
  test("a round in flight at stop finishes before stop returns, and no new round starts", async () => {
    const v = await volume();
    let started = 0;
    let finished = false;
    const running = await serve({
      inventoryPath: v.inventory,
      configPath: v.configPath,
      port: 0,
      peerPort: 0,
      discover: false,
      container: { recovered: false },
      syncIntervalMs: 20,
      syncRound: async () => {
        started += 1;
        await Bun.sleep(1200);
        finished = true;
      },
    });
    cleanup.push(() => running.stop());
    const deadline = Date.now() + 10_000;
    while (started === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(started).toBeGreaterThan(0);
    expect(finished).toBe(false);
    await running.stop();
    expect(finished).toBe(true);
    const atStop = started;
    await Bun.sleep(150);
    expect(started).toBe(atStop);
  });

  test("a round that never ends is abandoned after the shutdown bound", async () => {
    const v = await volume();
    let started = 0;
    const running = await serve({
      inventoryPath: v.inventory,
      configPath: v.configPath,
      port: 0,
      peerPort: 0,
      discover: false,
      container: { recovered: false },
      syncIntervalMs: 20,
      syncRound: () => {
        started += 1;
        return new Promise(() => undefined);
      },
    });
    cleanup.push(() => running.stop());
    const deadline = Date.now() + 10_000;
    while (started === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(started).toBeGreaterThan(0);
    const t0 = Date.now();
    await running.stop();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(9_500);
    expect(waited).toBeLessThan(15_000);
  });
});
