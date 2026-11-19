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

let dir: string;
let inventory: string;
const clock = () => Date.parse("2026-11-19T10:00:00Z");

const legacyState = {
  version: 1,
  operations: {
    a: { state: "pending", updatedAt: 1 },
    b: { state: "approved", updatedAt: 1, approval: { id: "x" } },
    c: { state: "executing", updatedAt: 1, spawnAttempted: false },
    d: { state: "succeeded", updatedAt: 1, finishedAt: 1 },
  },
  idempotency: {},
  consumedNonces: ["n1"],
};

async function legacyWorkspace() {
  await writeFile(inventory, "version: 1\nmachines: {}\n");
  await mkdir(join(dir, "control-plane"));
  await writeFile(
    join(dir, "control-plane", "state.json"),
    JSON.stringify(legacyState),
  );
  await writeFile(join(dir, "saved-commands.json"), '{"version":1}');
  await writeFile(join(dir, "unrelated.txt"), "not ours");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-migrate-"));
  inventory = join(dir, "inventory.yaml");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

describe("migrate", () => {
  test("fresh workspace gets a marker without a backup", async () => {
    const result = await migrate(inventory, { clock });
    expect(result).toEqual({ status: "initialized", version: DATA_VERSION });
    expect(await readdir(dir)).toEqual([MARKER_FILE]);
  });

  test("dry run lists steps and changes nothing", async () => {
    await legacyWorkspace();
    const result = await migrate(inventory, { dryRun: true, clock });
    expect(result.status).toBe("planned");
    if (result.status === "planned")
      expect(result.steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    expect(await detectVersion(inventory)).toBe(2);
    expect((await readdir(dir)).includes("backups")).toBe(false);
  });

  test("0.2 workspace: backup, retire open operations, keep history, mark v3", async () => {
    await legacyWorkspace();
    const result = await migrate(inventory, { clock });
    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") return;
    expect(result.notes[0]).toContain("3 open operation");
    const state = JSON.parse(
      await readFile(join(dir, "control-plane", "state.json"), "utf8"),
    );
    expect(state.operations.a.state).toBe("failed");
    expect(state.operations.b.state).toBe("failed");
    expect(state.operations.c.state).toBe("unknown");
    expect(state.operations.c.spawnAttempted).toBe(true);
    expect(state.operations.d.state).toBe("succeeded");
    expect(state.consumedNonces).toEqual(["n1"]);
    // Backup holds the untouched original and a manifest; unrelated files are not copied.
    const backup = JSON.parse(
      await readFile(
        join(result.backup, "control-plane", "state.json"),
        "utf8",
      ),
    );
    expect(backup).toEqual(legacyState);
    const manifest = JSON.parse(
      await readFile(join(result.backup, "manifest.json"), "utf8"),
    );
    expect(Object.keys(manifest.files).sort()).toEqual([
      "control-plane/state.json",
      "inventory.yaml",
      "saved-commands.json",
    ]);
    expect(await detectVersion(inventory)).toBe(DATA_VERSION);
    const marker = JSON.parse(await readFile(join(dir, MARKER_FILE), "utf8"));
    expect(marker.history[0]).toMatchObject({ from: 2, to: 3 });
    expect(await readFile(join(dir, "unrelated.txt"), "utf8")).toBe("not ours");
  });

  test("re-running is idempotent", async () => {
    await legacyWorkspace();
    await migrate(inventory, { clock });
    expect(await migrate(inventory, { clock })).toEqual({
      status: "current",
      version: DATA_VERSION,
    });
  });

  test("a failing step rolls back to the original data", async () => {
    await legacyWorkspace();
    const broken: MigrationStep = {
      id: "broken",
      from: 2,
      to: 3,
      description: "fails after writing",
      async run(context) {
        await writeFile(
          join(context.workspace, "saved-commands.json"),
          "garbage",
        );
        throw new Error("boom");
      },
      async verify() {},
    };
    await expect(
      migrate(inventory, { clock, steps: [broken] }),
    ).rejects.toThrow("rolled back");
    expect(await readFile(join(dir, "saved-commands.json"), "utf8")).toBe(
      '{"version":1}',
    );
    expect(await detectVersion(inventory)).toBe(2);
    expect((await readdir(dir)).includes("migration-progress.json")).toBe(
      false,
    );
  });

  test("a failing verification also rolls back", async () => {
    await legacyWorkspace();
    const lying: MigrationStep = {
      id: "lying",
      from: 2,
      to: 3,
      description: "claims success",
      async run() {},
      async verify() {
        throw new Error("not in place");
      },
    };
    await expect(migrate(inventory, { clock, steps: [lying] })).rejects.toThrow(
      "rolled back",
    );
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

describe("step chain", () => {
  test("chain from v2 reaches the current version", () => {
    const chain = pendingSteps(2);
    expect(chain.at(-1)?.to).toBe(DATA_VERSION);
  });
});
