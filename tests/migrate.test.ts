import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPaths } from "../src/migrate/files";
import {
  DATA_VERSION,
  detectVersion,
  MARKER_FILE,
  type MigrationStep,
  migrate,
  pendingSteps,
  requireCurrent,
} from "../src/migrate";
import { STEPS } from "../src/migrate/steps";

// Engine tests: versioning, backup, rollback, the untouched-file check and
// the interrupted-run recovery. Step-level fixtures live in migrate-steps.test.ts
// and migrate-clients.test.ts.

let dir: string;
let brokerDir: string;
let inventory: string;
const clock = () => Date.parse("2026-11-20T10:00:00Z");

const legacyState = {
  version: 1,
  operations: {
    a: { state: "pending", updatedAt: 1 },
    d: { state: "succeeded", updatedAt: 1, finishedAt: 1 },
  },
};

async function legacyWorkspace() {
  await writeFile(inventory, "version: 1\nmachines: {}\n");
  await mkdir(join(dir, "control-plane"));
  await writeFile(
    join(dir, "control-plane", "state.json"),
    JSON.stringify(legacyState),
  );
  await writeFile(join(dir, "saved-commands.json"), '{"version":1}');
  await writeFile(join(dir, "known_hosts"), "lab ssh-ed25519 AAAAFIXTURE\n");
  await writeFile(join(dir, "unrelated.txt"), "not ours");
}

// A step that declares the 0.2 state file and rewrites it.
const closeOps = (overrides: Partial<MigrationStep> = {}): MigrationStep => ({
  id: "close-ops",
  from: 2,
  to: 3,
  description: "closes the fixture's open operation",
  touches: () => [join(dir, "control-plane", "state.json")],
  async run() {
    const path = join(dir, "control-plane", "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.operations.a.state = "failed";
    await writeFile(path, JSON.stringify(state));
  },
  async verify() {
    const state = JSON.parse(
      await readFile(join(dir, "control-plane", "state.json"), "utf8"),
    );
    if (state.operations.a.state === "pending")
      throw new Error("still pending");
  },
  ...overrides,
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(path: string, rel: string) {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name);
      const key = rel ? `${rel}/${name}` : name;
      if (key === "backups") continue;
      if (
        await readdir(full).then(
          () => true,
          () => false,
        )
      )
        await walk(full, key);
      else out[key] = await readFile(full, "utf8");
    }
  }
  await walk(root, "");
  return out;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-migrate-"));
  brokerDir = await mkdtemp(join(tmpdir(), "homectl-migrate-broker-"));
  inventory = join(dir, "inventory.yaml");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(brokerDir, { recursive: true, force: true });
});

describe("data version detection", () => {
  test("empty workspace is 0, legacy files are 2, marker wins", async () => {
    expect(await detectVersion(inventory)).toBe(0);
    await writeFile(inventory, "version: 1\nmachines: {}\n");
    expect(await detectVersion(inventory)).toBe(2);
    await writeFile(
      join(dir, MARKER_FILE),
      JSON.stringify({ data_version: 3, history: [] }),
    );
    expect(await detectVersion(inventory)).toBe(3);
  });

  test("an invalid marker is refused", async () => {
    await writeFile(join(dir, MARKER_FILE), '{"data_version":1}');
    await expect(detectVersion(inventory)).rejects.toThrow("data_version");
  });

  test("requireCurrent asks for migration on 0.2 data", async () => {
    await requireCurrent(inventory);
    await writeFile(inventory, "version: 1\nmachines: {}\n");
    await expect(requireCurrent(inventory)).rejects.toThrow("home-ctl migrate");
  });
});

describe("step chain", () => {
  const step = (
    from: number,
    to: number,
    id = `s${from}-${to}`,
  ): MigrationStep => ({
    ...closeOps(),
    id,
    from,
    to,
  });

  test("the built-in chain reaches the current version from 2, and nothing is pending at 3", () => {
    expect(pendingSteps(2).at(-1)?.to).toBe(DATA_VERSION);
    expect(pendingSteps(2).map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    expect(pendingSteps(DATA_VERSION)).toEqual([]);
  });

  test("several steps in one hop all run, in order", () => {
    const chain = pendingSteps(2, [step(2, 3, "a"), step(2, 3, "b")]);
    expect(chain.map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("a gap in the chain is refused", () => {
    expect(() => pendingSteps(2, [step(3, 4)])).toThrow("gap");
  });

  test("a chain that stops short of the current version is refused", () => {
    expect(() => pendingSteps(2, [])).toThrow("No migration path");
  });
});

describe("migrate", () => {
  test("fresh workspace gets a marker without a backup", async () => {
    const result = await migrate(inventory, { clock });
    expect(result).toEqual({ status: "initialized", version: DATA_VERSION });
    expect(await readdir(dir)).toEqual([MARKER_FILE]);
  });

  test("dry run lists each step with the paths it may touch and changes nothing", async () => {
    await legacyWorkspace();
    const before = await snapshot(dir);
    const result = await migrate(inventory, {
      dryRun: true,
      clock,
      brokerState: brokerDir,
    });
    expect(result.status).toBe("planned");
    if (result.status !== "planned") return;
    expect(result.steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    const carry = result.steps.find((s) => s.id === "v2-carry-agent-clients");
    expect(carry?.touches).toEqual(["broker-state/clients.json"]);
    expect(result.steps[0]?.touches).toEqual(["control-plane/state.json"]);
    expect(await snapshot(dir)).toEqual(before);
  });

  test("a 0.2 workspace is backed up with exactly the declared files, then marked v3", async () => {
    await legacyWorkspace();
    const result = await migrate(inventory, {
      clock,
      brokerState: brokerDir,
      steps: [closeOps()],
    });
    if (result.status !== "migrated") throw new Error("expected migrated");
    const manifest = JSON.parse(
      await readFile(join(result.backup, "manifest.json"), "utf8"),
    );
    expect(manifest.entries.map((e: { path: string }) => e.path)).toEqual([
      join(dir, MARKER_FILE),
      join(dir, "control-plane", "state.json"),
    ]);
    // Never copied: secrets and trust material the step does not touch.
    expect(await readdir(result.backup)).not.toContain("known_hosts");
    expect(
      JSON.parse(
        await readFile(join(dir, "control-plane", "state.json"), "utf8"),
      ).operations.a.state,
    ).toBe("failed");
    expect(await readFile(join(dir, "unrelated.txt"), "utf8")).toBe("not ours");
    expect(await readFile(join(dir, "known_hosts"), "utf8")).toBe(
      "lab ssh-ed25519 AAAAFIXTURE\n",
    );
    const marker = JSON.parse(await readFile(join(dir, MARKER_FILE), "utf8"));
    expect(marker.history[0]).toMatchObject({
      from: 2,
      to: 3,
      steps: ["close-ops"],
    });
    expect(await detectVersion(inventory)).toBe(DATA_VERSION);
  });

  test("running it again changes nothing: the second run reports current", async () => {
    await legacyWorkspace();
    await migrate(inventory, {
      clock,
      brokerState: brokerDir,
      steps: [closeOps()],
    });
    const once = await snapshot(dir);
    expect(
      await migrate(inventory, {
        clock,
        brokerState: brokerDir,
        steps: [closeOps()],
      }),
    ).toEqual({
      status: "current",
      version: DATA_VERSION,
    });
    expect(await snapshot(dir)).toEqual(once);
  });

  test("a failing run rolls back: declared files, created files and progress are restored", async () => {
    await legacyWorkspace();
    const before = await snapshot(dir);
    const broken: MigrationStep = {
      id: "broken",
      from: 2,
      to: 3,
      description: "writes, then fails",
      touches: () => [
        join(dir, "control-plane", "state.json"),
        join(brokerDir, "clients.json"),
      ],
      async run() {
        await writeFile(join(dir, "control-plane", "state.json"), "garbage");
        await writeFile(join(brokerDir, "clients.json"), "garbage");
        throw new Error("boom");
      },
      async verify() {},
    };
    await expect(
      migrate(inventory, { clock, brokerState: brokerDir, steps: [broken] }),
    ).rejects.toThrow("rolled back");
    const after = await snapshot(dir);
    expect(after["control-plane/state.json"]).toBe(
      before["control-plane/state.json"],
    );
    expect(after[MARKER_FILE]).toBeUndefined();
    expect(after["migration-progress.json"]).toBeUndefined();
    expect(await readdir(brokerDir)).toEqual([]);
    expect(await detectVersion(inventory)).toBe(2);
  });

  test("a failed verification rolls back the step's writes", async () => {
    await legacyWorkspace();
    const before = await readFile(
      join(dir, "control-plane", "state.json"),
      "utf8",
    );
    const lying = closeOps({
      id: "lying",
      async verify() {
        throw new Error("not in place");
      },
    });
    await expect(
      migrate(inventory, { clock, brokerState: brokerDir, steps: [lying] }),
    ).rejects.toThrow("rolled back");
    expect(
      await readFile(join(dir, "control-plane", "state.json"), "utf8"),
    ).toBe(before);
    expect(await detectVersion(inventory)).toBe(2);
  });

  test("a write to a file the step did not declare is refused and rolled back", async () => {
    await legacyWorkspace();
    const before = await readFile(join(dir, "saved-commands.json"), "utf8");
    const sneaky: MigrationStep = {
      id: "sneaky",
      from: 2,
      to: 3,
      description: "writes an undeclared file",
      touches: () => [],
      async run() {
        await writeFile(join(dir, "saved-commands.json"), "rewritten");
      },
      async verify() {},
    };
    await expect(
      migrate(inventory, { clock, brokerState: brokerDir, steps: [sneaky] }),
    ).rejects.toThrow("rolled back");
    expect(await readFile(join(dir, "saved-commands.json"), "utf8")).toBe(
      before,
    );
  });

  test("a new file the step did not declare is refused", async () => {
    await legacyWorkspace();
    const sneaky: MigrationStep = {
      id: "new-file",
      from: 2,
      to: 3,
      description: "creates an undeclared file",
      touches: () => [],
      async run() {
        await writeFile(join(dir, "surprise.txt"), "new");
      },
      async verify() {},
    };
    const failure = await migrate(inventory, {
      clock,
      brokerState: brokerDir,
      steps: [sneaky],
    }).then(
      () => undefined,
      (error: { details?: { reason?: string } }) => error,
    );
    expect(failure?.details?.reason).toContain("surprise.txt");
    expect(await detectVersion(inventory)).toBe(2);
    expect(await readdir(dir)).not.toContain("surprise.txt");
  });

  test("a declared file outside the workspace is restored on rollback", async () => {
    await legacyWorkspace();
    const target = join(brokerDir, "clients.json");
    await writeFile(target, '{"version":1,"clients":{}}');
    const failing: MigrationStep = {
      id: "outside",
      from: 2,
      to: 3,
      description: "rewrites broker state, then fails",
      touches: () => [target],
      async run() {
        await writeFile(target, "changed");
        throw new Error("boom");
      },
      async verify() {},
    };
    await expect(
      migrate(inventory, { clock, brokerState: brokerDir, steps: [failing] }),
    ).rejects.toThrow("rolled back");
    expect(await readFile(target, "utf8")).toBe('{"version":1,"clients":{}}');
  });

  test("an interrupted run is rolled back before the next attempt", async () => {
    await legacyWorkspace();
    const statePath = join(dir, "control-plane", "state.json");
    const original = await readFile(statePath, "utf8");
    // Simulate a crash: a backup and progress file exist, the file is half written.
    const backup = join(dir, "backups", "migration-v2-crashed");
    await backupPaths(backup, [statePath], {
      from: 2,
      to: 3,
      created: "2026-11-20T09:00:00Z",
    });
    await writeFile(
      join(dir, "migration-progress.json"),
      JSON.stringify({
        from: 2,
        to: 3,
        backup,
        touched: [statePath],
        completed: [],
      }),
    );
    await writeFile(statePath, "half written");
    const noop: MigrationStep = {
      id: "noop",
      from: 2,
      to: 3,
      description: "",
      touches: () => [],
      async run() {},
      async verify() {},
    };
    const result = await migrate(inventory, {
      clock,
      brokerState: brokerDir,
      steps: [noop],
    });
    if (result.status !== "migrated") throw new Error("expected migrated");
    expect(result.notes.join(" ")).toContain(
      "interrupted migration was rolled back",
    );
    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(await detectVersion(inventory)).toBe(DATA_VERSION);
  });

  test("a progress file whose backup is missing is refused, not guessed at", async () => {
    await legacyWorkspace();
    await writeFile(
      join(dir, "migration-progress.json"),
      JSON.stringify({
        from: 2,
        to: 3,
        backup: join(dir, "backups", "gone"),
        touched: [],
        completed: [],
      }),
    );
    const noop: MigrationStep = {
      id: "noop",
      from: 2,
      to: 3,
      description: "",
      touches: () => [],
      async run() {},
      async verify() {},
    };
    await expect(
      migrate(inventory, { clock, brokerState: brokerDir, steps: [noop] }),
    ).rejects.toThrow("backup is missing");
    expect(await detectVersion(inventory)).toBe(2);
  });

  test("newer data is refused instead of downgraded", async () => {
    await writeFile(
      join(dir, MARKER_FILE),
      JSON.stringify({ data_version: 99, history: [] }),
    );
    await expect(migrate(inventory, { clock })).rejects.toThrow(
      "newer homectl",
    );
  });
});
