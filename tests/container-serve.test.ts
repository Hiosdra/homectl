import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(90_000);

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { LAUNCH_FILE, RUN_FILE } from "../src/container/recovery";
import { serveContainer } from "../src/container/run";
import { serve } from "../src/serve";

const REPO = resolve(import.meta.dir, "..");
const MAIN = join(REPO, "src", "cli", "main.ts");

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

// Child processes: the real CLI entry point, with synthetic paths and ports.
function spawnServe(args: string[]) {
  return Bun.spawn([process.execPath, MAIN, "serve", "--container", ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
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
