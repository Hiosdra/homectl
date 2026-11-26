import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { migrationTarget } from "../src/cli/migrate-command";
import { cleanEnv } from "../src/credentials";
import { DATA_VERSION, MARKER_FILE } from "../src/migrate";

// `home-ctl migrate` through the real CLI entry point (src/cli/migrate-command.ts).
const cli = join(import.meta.dir, "../src/cli/main.ts");
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    code: await child.exited,
  };
}

// A 0.2 workspace: an inventory, and control-plane state with one open operation.
async function legacyWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-migrate-cli-"));
  dirs.push(dir);
  const inventory = join(dir, "inventory.yaml");
  await writeFile(inventory, "version: 1\nmachines: {}\n");
  await mkdir(join(dir, "control-plane"));
  await writeFile(
    join(dir, "control-plane", "state.json"),
    JSON.stringify({
      version: 1,
      operations: { a: { state: "pending", updatedAt: 1 } },
    }),
  );
  return { dir, inventory };
}

describe("home-ctl migrate", () => {
  test("--dry-run plans the steps and leaves the workspace as it was", async () => {
    const { dir, inventory } = await legacyWorkspace();
    const result = await invoke([
      "migrate",
      "--inventory",
      inventory,
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.status).toBe("planned");
    expect(plan.from).toBe(2);
    expect(plan.to).toBe(DATA_VERSION);
    expect(plan.steps.map((s: { id: string }) => s.id)).toContain(
      "v2-retire-pending-authority",
    );
    expect(await readdir(dir)).not.toContain(MARKER_FILE);
    expect(await readdir(dir)).not.toContain("backups");
  });

  test("a real run backs up, closes the open operation and writes the marker", async () => {
    const { dir, inventory } = await legacyWorkspace();
    const result = await invoke([
      "migrate",
      "--inventory",
      inventory,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const outcome = JSON.parse(result.stdout);
    expect(outcome.status).toBe("migrated");
    expect(outcome.to).toBe(DATA_VERSION);
    const state = JSON.parse(
      await readFile(join(dir, "control-plane", "state.json"), "utf8"),
    );
    expect(state.operations.a.state).toBe("failed");
    expect(state.operations.a.reason).toBe("retired-by-migration");
    expect(await readdir(join(dir, "backups"))).toHaveLength(1);
    const marker = JSON.parse(await readFile(join(dir, MARKER_FILE), "utf8"));
    expect(marker.data_version).toBe(DATA_VERSION);
  });

  test("running it again on current data changes nothing", async () => {
    const { inventory } = await legacyWorkspace();
    expect(
      (await invoke(["migrate", "--inventory", inventory, "--json"])).code,
    ).toBe(0);
    const again = await invoke(["migrate", "--inventory", inventory, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({
      status: "current",
      version: DATA_VERSION,
    });
  });

  test("a human-readable run also succeeds", async () => {
    const { inventory } = await legacyWorkspace();
    const result = await invoke([
      "migrate",
      "--inventory",
      inventory,
      "--dry-run",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test("extra arguments are refused with the usage line", async () => {
    const { inventory } = await legacyWorkspace();
    const result = await invoke(["migrate", "extra", "--inventory", inventory]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: home-ctl migrate");
  });

  test("an unknown --mode is refused before anything is read", async () => {
    const { dir, inventory } = await legacyWorkspace();
    const result = await invoke([
      "migrate",
      "--mode",
      "luna",
      "--inventory",
      inventory,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--mode is compat or hardened");
    expect(await readdir(dir)).not.toContain("backups");
  });
});

describe("migrationTarget", () => {
  test("compat keeps the inventory and uses the broker folder beside it", () => {
    const inventory = resolve("homectl", "inventory.yaml");
    const target = migrationTarget("compat", inventory, "linux");
    expect(target.inventoryPath).toBe(inventory);
    expect(target.brokerState).toBe(join(dirname(inventory), "broker"));
  });

  test("hardened migrates the service state that daemon run starts from", () => {
    const target = migrationTarget(
      "hardened",
      "/home/owner/.config/homectl/inventory.yaml",
      "linux",
    );
    expect(target.brokerState).toBe("/var/lib/homectl");
    expect(target.inventoryPath).toBe(
      join("/var/lib/homectl", "workspace", "inventory.yaml"),
    );
  });
});
