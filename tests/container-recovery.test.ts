import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTANCE_ID,
  LAUNCH_FILE,
  markRunning,
  markStopped,
  RUN_FILE,
  recoverStartup,
  STALE_AFTER_MS,
  serveDirectoryOf,
} from "../src/container/recovery";
import { AuditJournal } from "../src/control/journal";
import { HomectlError } from "../src/types";

// Synthetic volume laid out like /data: inventory beside serve/ and control-plane/.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function volume() {
  const root = await mkdtemp(join(tmpdir(), "homectl-recovery-"));
  dirs.push(root);
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  const inventory = join(data, "inventory.yaml");
  return {
    inventory,
    serveDir: serveDirectoryOf(inventory),
    controlDir: join(data, "control-plane"),
  };
}

async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: number; message: string } | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HomectlError)
      return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}

describe("startup recovery", () => {
  test("a fresh volume starts clean", async () => {
    const v = await volume();
    expect(await recoverStartup({ inventoryPath: v.inventory })).toEqual({
      status: "clean",
      warnings: [],
    });
  });

  test("after a clean stop the next start is clean", async () => {
    const v = await volume();
    await markRunning(v.inventory, "0.0.0-test");
    await markStopped(v.inventory, "0.0.0-test");
    const run = JSON.parse(await readFile(join(v.serveDir, RUN_FILE), "utf8"));
    expect(run.state).toBe("stopped");
    expect((await recoverStartup({ inventoryPath: v.inventory })).status).toBe(
      "clean",
    );
  });

  test("a fresh heartbeat from another instance refuses the start (exit 3) and names the host and age", async () => {
    const v = await volume();
    await mkdir(v.serveDir, { recursive: true });
    const heartbeat = new Date(Date.now() - 5_000).toISOString();
    await writeFile(
      join(v.serveDir, RUN_FILE),
      JSON.stringify({
        state: "running",
        startedAt: "2026-11-01T00:00:00.000Z",
        instanceId: "00000000-0000-4000-8000-000000000001",
        hostname: "nas-test-a",
        heartbeatAt: heartbeat,
      }),
    );
    const error = await refusal(recoverStartup({ inventoryPath: v.inventory }));
    expect(error?.code).toBe(3);
    expect(error?.message).toMatch(
      /^another homectl instance is using this data directory \(host nas-test-a, heartbeat \d+ s ago\)$/,
    );
  });

  test("a stale heartbeat from another instance is an unclean previous run: start degraded", async () => {
    const v = await volume();
    await mkdir(v.serveDir, { recursive: true });
    const heartbeat = new Date(
      Date.now() - (STALE_AFTER_MS + 60_000),
    ).toISOString();
    await writeFile(
      join(v.serveDir, RUN_FILE),
      JSON.stringify({
        state: "running",
        startedAt: "2026-11-01T00:00:00.000Z",
        instanceId: "00000000-0000-4000-8000-000000000001",
        hostname: "nas-test-a",
        heartbeatAt: heartbeat,
      }),
    );
    const result = await recoverStartup({ inventoryPath: v.inventory });
    expect(result.status).toBe("recovered");
    expect(result.warnings[0]).toContain("did not stop cleanly");
  });

  test("a running record without a heartbeat (older format) is an unclean run, not a duplicate", async () => {
    const v = await volume();
    await mkdir(v.serveDir, { recursive: true });
    await writeFile(
      join(v.serveDir, RUN_FILE),
      JSON.stringify({
        state: "running",
        startedAt: "2026-11-01T00:00:00.000Z",
      }),
    );
    const result = await recoverStartup({ inventoryPath: v.inventory });
    expect(result.status).toBe("recovered");
  });

  test("this instance's own record is not a duplicate", async () => {
    const v = await volume();
    await markRunning(v.inventory, "0.0.0-test");
    const run = JSON.parse(await readFile(join(v.serveDir, RUN_FILE), "utf8"));
    expect(run.instanceId).toBe(INSTANCE_ID);
    expect(run.hostname).toBe(hostname());
    expect(typeof run.heartbeatAt).toBe("string");
    expect(await recoverStartup({ inventoryPath: v.inventory })).toEqual({
      status: "clean",
      warnings: [],
    });
  });

  test("a heartbeat refresh keeps the start time and moves the heartbeat forward", async () => {
    const v = await volume();
    await markRunning(v.inventory, "0.0.0-test");
    const first = JSON.parse(
      await readFile(join(v.serveDir, RUN_FILE), "utf8"),
    );
    await Bun.sleep(5);
    await markRunning(v.inventory, "0.0.0-test");
    const second = JSON.parse(
      await readFile(join(v.serveDir, RUN_FILE), "utf8"),
    );
    expect(second.startedAt).toBe(first.startedAt);
    expect(Date.parse(second.heartbeatAt)).toBeGreaterThan(
      Date.parse(first.heartbeatAt),
    );
  });

  test("a stopped record from another instance never blocks the start", async () => {
    const v = await volume();
    await mkdir(v.serveDir, { recursive: true });
    await writeFile(
      join(v.serveDir, RUN_FILE),
      JSON.stringify({ state: "stopped", instanceId: "other" }),
    );
    expect((await recoverStartup({ inventoryPath: v.inventory })).status).toBe(
      "clean",
    );
  });

  test("an unreadable or malformed run marker refuses the start (exit 5)", async () => {
    const v = await volume();
    await mkdir(v.serveDir, { recursive: true });
    await writeFile(join(v.serveDir, RUN_FILE), "not json");
    expect(
      (await refusal(recoverStartup({ inventoryPath: v.inventory })))?.code,
    ).toBe(5);
    await writeFile(join(v.serveDir, RUN_FILE), JSON.stringify({ state: "x" }));
    expect(
      (await refusal(recoverStartup({ inventoryPath: v.inventory })))?.code,
    ).toBe(5);
  });

  test("an audit journal shorter than its anchor refuses the start and changes nothing", async () => {
    const v = await volume();
    await mkdir(v.controlDir, { recursive: true });
    const anchor = JSON.stringify({ v: 1, seq: 5, hash: "a".repeat(64) });
    await writeFile(join(v.controlDir, "audit.anchor"), anchor);
    const error = await refusal(recoverStartup({ inventoryPath: v.inventory }));
    expect(error?.code).toBe(5);
    expect(error?.message).toContain("failed startup verification");
    // Nothing repaired: the anchor is untouched.
    expect(await readFile(join(v.controlDir, "audit.anchor"), "utf8")).toBe(
      anchor,
    );
  });

  test("a half-written audit tail refuses the start (exit 5)", async () => {
    const v = await volume();
    await mkdir(v.controlDir, { recursive: true });
    await writeFile(join(v.controlDir, "audit.jsonl"), '{"v":1,"seq":1,"hash"');
    expect(
      (await refusal(recoverStartup({ inventoryPath: v.inventory })))?.code,
    ).toBe(5);
  });

  test("a lagging anchor from a crash between append and anchor write is accepted", async () => {
    const v = await volume();
    await mkdir(v.controlDir, { recursive: true });
    const journal = new AuditJournal(
      join(v.controlDir, "audit.jsonl"),
      join(v.controlDir, "audit.anchor"),
      () => Date.parse("2026-11-01T00:00:00.000Z"),
    );
    await journal.append({ event: "client.created", client: "synthetic-a" });
    const anchorAfterFirst = await readFile(
      join(v.controlDir, "audit.anchor"),
      "utf8",
    );
    await journal.append({ event: "client.created", client: "synthetic-b" });
    // Simulate the crash: the second entry was appended, the anchor was not rewritten.
    await writeFile(join(v.controlDir, "audit.anchor"), anchorAfterFirst);
    expect((await recoverStartup({ inventoryPath: v.inventory })).status).toBe(
      "clean",
    );
  });

  test("half-written temp files are reported and kept", async () => {
    const v = await volume();
    await mkdir(v.controlDir, { recursive: true });
    const leftover = "state.json.0f9c.tmp";
    await writeFile(join(v.controlDir, leftover), "{partial");
    const result = await recoverStartup({ inventoryPath: v.inventory });
    expect(result.status).toBe("recovered");
    expect(result.warnings.join("\n")).toContain(leftover);
    expect(await readFile(join(v.controlDir, leftover), "utf8")).toBe(
      "{partial",
    );
  });

  test("a stale panel launch token from an earlier run is removed", async () => {
    const v = await volume();
    await mkdir(v.serveDir, { recursive: true });
    const launch = join(v.serveDir, LAUNCH_FILE);
    await writeFile(
      launch,
      JSON.stringify({ url: "http://127.0.0.1:1", token: "x" }),
    );
    const result = await recoverStartup({ inventoryPath: v.inventory });
    expect(result.status).toBe("recovered");
    expect(await Bun.file(launch).exists()).toBe(false);
  });

  test("a control lock from a dead process is reported; from a live one it refuses", async () => {
    const v = await volume();
    await mkdir(v.controlDir, { recursive: true });
    await writeFile(join(v.controlDir, ".lock"), "424242\n");
    const reported = await recoverStartup({
      inventoryPath: v.inventory,
      isAlive: () => false,
    });
    expect(reported.status).toBe("recovered");
    expect(reported.warnings.join("\n")).toContain("control-plane lock");
    expect(
      (
        await refusal(
          recoverStartup({ inventoryPath: v.inventory, isAlive: () => true }),
        )
      )?.code,
    ).toBe(3);
  });
});
