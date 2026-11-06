import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlCommand } from "../src/control/cli";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import { renderOperations } from "../src/control/present";
import type { OpBody } from "../src/control/replicate";
import { emptyReplica } from "../src/control/replicate";
import { type ReplicaFile, takeoverStatusOf } from "../src/control/replicator";
import { localApi } from "../src/peer/local-api";
import { serve } from "../src/serve";
import { HomectlError } from "../src/types";

setDefaultTimeout(120_000);

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const dirs: string[] = [];
const stops: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

type Server = Awaited<ReturnType<typeof serve>>;

async function workspace(): Promise<{ dir: string; inventory: string }> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-admin-"));
  dirs.push(dir);
  const inventory = join(dir, "inventory.yaml");
  await writeFile(inventory, INVENTORY);
  return { dir, inventory };
}

async function running(inventory: string): Promise<Server> {
  const s = await serve({
    inventoryPath: inventory,
    configPath: `${inventory}.ssh_config`,
    port: 0,
    peerPort: 0,
    discover: false,
    controlRunner: async () => ({ exitCode: 0, stdout: "demo\n", stderr: "" }),
  });
  s.hub.state.name = "Linux";
  await s.hub.save();
  stops.push(() => s.stop());
  return s;
}

async function launchToken(s: Server): Promise<string> {
  const launch = JSON.parse(await readFile(s.launch, "utf8")) as {
    token: string;
  };
  return launch.token;
}

// Sends one raw HTTP/1.1 request on loopback and returns the status code.
function rawStatus(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let head = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.on("data", (chunk) => {
      head += chunk.toString();
      if (head.includes("\r\n")) {
        resolve(Number(head.split(" ")[1]));
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });
}

function cli(
  inventory: string,
  positionals: string[],
  values: Record<string, string | boolean | undefined> = {},
) {
  return controlCommand({
    inventoryPath: inventory,
    configPath: `${inventory}.ssh_config`,
    positionals,
    values: values as never,
    dryRun: false,
    json: true,
    color: false,
  });
}

describe("local admin route (panel gate)", () => {
  test("rejects a missing or wrong launch token before any admin data is served", async () => {
    const { inventory } = await workspace();
    const s = await running(inventory);
    const missing = await fetch(`${s.url}/api/connect`, {
      method: "POST",
      headers: { Origin: s.url, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(403);
    const wrong = await fetch(`${s.url}/api/connect`, {
      method: "POST",
      headers: { Origin: s.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-the-token" }),
    });
    expect(wrong.status).toBe(403);
    // Without the session cookie the sync view is closed.
    const anonymous = await fetch(`${s.url}/api/control/sync`);
    expect(anonymous.status).toBe(403);
  });

  test("the CLI client reaches the sync view and handoff with the launch token", async () => {
    const { inventory } = await workspace();
    const s = await running(inventory);
    const view = await localApi<{ running: boolean; peers: unknown[] }>(
      inventory,
      "/api/control/sync",
    );
    expect(view.running).toBe(true);
    expect(view.peers).toEqual([]);
    // The token is read from the launch file and never returned by the API.
    expect(JSON.stringify(view)).not.toContain(await launchToken(s));
  });

  test("a POST from a foreign Origin or a non-loopback Host is refused", async () => {
    const { inventory } = await workspace();
    const s = await running(inventory);
    const token = await launchToken(s);
    const connect = await fetch(`${s.url}/api/connect`, {
      method: "POST",
      headers: { Origin: s.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = connect.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("homectl=");
    const foreign = await fetch(`${s.url}/api/control/handoff`, {
      method: "POST",
      headers: {
        Origin: "http://evil.example",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operationId: "00000000", to: "Linux" }),
    });
    expect(foreign.status).toBe(403);
    // A raw request keeps the Host header exactly as written. The same request
    // with the loopback Host succeeds, so the refusal is the Host check itself.
    const port = Number(s.localServer.port);
    const sent = (host: string) =>
      rawStatus(
        port,
        `GET /api/control/sync HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
      );
    expect(await sent(`evil.example:${port}`)).toBe(403);
    expect(await sent(`127.0.0.1:${port}`)).toBe(200);
  });

  test("handoff refuses unknown operations, unknown devices, and a missing device name", async () => {
    const { inventory } = await workspace();
    const s = await running(inventory);
    await expect(
      localApi(inventory, "/api/control/handoff", {
        operationId: "00000000",
        to: "Windows",
      }),
    ).rejects.toMatchObject({ code: 2 });
    const client = await s.control.createClient({
      id: "codex-pc",
      name: "codex-pc",
      scopes: ["plan:create", "status:read"],
      hosts: ["agent-host"],
    });
    const identity = await s.control.authenticate(client.token);
    if (!identity) throw new Error("token did not authenticate");
    const made = (await s.control.request(
      { kind: "client", client: identity },
      { op: "plan", host: "agent-host", argv: ["hostname"] },
    )) as { operationId: string };
    // Owned here with no paired device: the offer names a device that does not exist.
    await expect(
      localApi(inventory, "/api/control/handoff", {
        operationId: made.operationId,
        to: "Windows",
      }),
    ).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining("No paired device named Windows"),
    });
    await expect(
      localApi(inventory, "/api/control/handoff", {
        operationId: made.operationId,
      }),
    ).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining("Name the device to hand off to"),
    });
  });
});

describe("--no-control-sync", () => {
  test("serve starts without control sync: the panel says so and nothing runs on a timer", async () => {
    const { inventory } = await workspace();
    const s = await serve({
      inventoryPath: inventory,
      configPath: `${inventory}.ssh_config`,
      port: 0,
      peerPort: 0,
      discover: false,
      controlSync: false,
      controlRunner: async () => ({
        exitCode: 0,
        stdout: "demo\n",
        stderr: "",
      }),
    });
    stops.push(() => s.stop());
    const view = await localApi<{ running: boolean; disabledBy?: string }>(
      inventory,
      "/api/control/sync",
    );
    expect(view).toMatchObject({
      running: false,
      disabledBy: "--no-control-sync",
    });
    await expect(s.syncNow()).rejects.toMatchObject({ code: 5 });
    const saved = await cli(inventory, ["sync"]);
    expect(saved.human).toContain("disabled by --no-control-sync");
  });
});

describe("control CLI with and without a running serve", () => {
  test("sync reports live state while serve runs, then the saved state with backoff unknown", async () => {
    const { inventory } = await workspace();
    const s = await running(inventory);
    const live = await cli(inventory, ["sync"]);
    expect(live.value).toMatchObject({ live: true });
    await s.stop();
    stops.length = 0;
    const saved = await cli(inventory, ["sync"]);
    expect(saved.value).toMatchObject({ live: false });
    expect(saved.human).toContain(
      "serve not running — showing last saved state; backoff unknown.",
    );
  });

  test("handoff needs a running serve and says so", async () => {
    const { inventory } = await workspace();
    const s = await running(inventory);
    await s.stop();
    stops.length = 0;
    await expect(
      cli(inventory, ["handoff", "00000000"], {
        to: "Windows",
      }),
    ).rejects.toMatchObject({
      code: 5,
      message: "Start homectl serve first",
    });
  });

  test("handoff without --to is a usage error", async () => {
    const { inventory } = await workspace();
    await expect(
      cli(inventory, ["handoff", "00000000"]),
    ).rejects.toBeInstanceOf(HomectlError);
  });
});

describe("pure replica views", () => {
  const base = {
    kind: "op",
    opId: "op-1",
    owner: "a",
    planner: "a",
    epoch: 1,
    seq: 1,
    state: "pending",
    host: "agent-host",
    argv: ["hostname"],
    impact: "",
    classification: "inspect",
    needsApproval: false,
    fingerprint: "f",
    issuer: "codex",
    updatedAt: new Date(0).toISOString(),
  } as OpBody;
  const data = (): ReplicaFile => ({
    version: 1,
    replica: emptyReplica(),
    logs: {},
    checkpoints: {},
    blocked: {},
    published: { ops: {}, clients: {} },
    peers: { a: { name: "Linux" } },
    syncedAt: {},
    seenAt: {},
    self: { id: "b", name: "Windows" },
  });
  const known = async () => true;

  test("takeover names the reason when no contact was ever recorded", async () => {
    const status = await takeoverStatusOf(data(), base, "a", 1_000_000, known);
    expect(status).toEqual({
      possible: false,
      reason: "No recent contact with Linux; takeover is not possible",
    });
  });

  test("takeover shows the earliest time once the window is known", async () => {
    const d = data();
    d.seenAt.a = 1_000;
    const status = await takeoverStatusOf(d, base, "a", 2_000, known);
    expect(status.possible).toBe(false);
    expect(status.at).toBe(new Date(1_000 + 120_000 + 60_000).toISOString());
    expect(status.reason).toContain("Takeover possible after");
  });

  test("takeover is refused when the host is not in this device's inventory", async () => {
    const d = data();
    d.seenAt.a = 0;
    const status = await takeoverStatusOf(
      d,
      base,
      "a",
      10_000_000,
      async () => false,
    );
    expect(status.possible).toBe(false);
    expect(status.reason).toContain("is not in this device's inventory");
  });

  test("ownership conflicts are never takeover candidates", async () => {
    const status = await takeoverStatusOf(data(), base, undefined, 0, known);
    expect(status.possible).toBe(false);
    expect(status.reason).toContain("Ownership is in conflict");
  });

  test("a forwarded approval reads as awaiting confirmation in the ops listing", () => {
    const text = renderOperations(
      [
        {
          operationId: "00000000-0000-4000-8000-000000000001",
          state: "pending",
          host: "agent-host",
          classification: "mutation",
          needsApproval: true,
          fingerprint: "f",
          argv: ["systemctl", "restart", "nginx"],
          impact: "",
          issuer: "codex",
          createdAt: new Date(0).toISOString(),
          expiresAt: new Date(60_000).toISOString(),
          updatedAt: new Date(0).toISOString(),
          expired: false,
          spawnAttempted: false,
          remote: true,
          runsOn: "Linux",
          delivery: {
            decision: "approve",
            status: "awaiting-confirmation",
            ownerName: "Linux",
            since: new Date(0).toISOString(),
          },
        },
      ],
      { color: false, now: 1_000 },
    );
    expect(text).toContain("runs on Linux");
    expect(text).toContain("forwarded to Linux, awaiting confirmation");
  });
});

describe("device key file mode", () => {
  test.skipIf(process.platform === "win32")(
    "a key readable by other users is refused on POSIX",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "homectl-key-"));
      dirs.push(dir);
      await loadOrCreateDeviceKey(dir);
      const path = join(dir, "device-key.json");
      await chmod(path, 0o644);
      await expect(loadOrCreateDeviceKey(dir)).rejects.toBeInstanceOf(
        HomectlError,
      );
      await chmod(path, 0o600);
      await loadOrCreateDeviceKey(dir);
      expect((await stat(path)).mode & 0o077).toBe(0);
    },
  );
});
