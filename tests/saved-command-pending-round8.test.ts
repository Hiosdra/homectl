import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePeerSyncRecords } from "../src/peer/apply-sync-records";
import type { Version } from "../src/peer/store";
import { SavedCommandStore } from "../src/saved-commands";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const template = {
  name: "Restart service",
  hosts: ["example"],
  argv: ["systemctl", "restart", "{{unit}}"],
  parameters: [{ name: "unit", description: "Service unit" }],
  description: "Restart one named service",
};

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-saved-pending-"));
  cleanup.push(dir);
  return dir;
}

test("an unreadable saved-command file leaves saved commands pending and still applies other records", async () => {
  const dir = await tempDir();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // A directory where the file should be: read fails with EISDIR, not corruption.
    const path = join(dir, "saved-commands.json");
    await mkdir(path);
    const store = new SavedCommandStore(path);
    const applied: { available: boolean; ids: string[] }[] = [];
    const result = await store.replaceFromRecordsWith(
      {
        "saved-command:abc": { value: { id: "abc" } },
        "machine:lab": { value: { name: "lab" } },
      },
      undefined,
      async (available, ids) => {
        applied.push({ available, ids });
      },
    );
    expect(result).toBe(false);
    expect(applied).toEqual([{ available: false, ids: [] }]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Saved commands were left unchanged"),
    );
  } finally {
    warning.mockRestore();
  }
});

test("a lock or private-directory failure leaves saved commands pending, not aborted", async () => {
  const dir = await tempDir();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // The store's directory is a regular file, so the lock cannot be taken.
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    const store = new SavedCommandStore(join(blocker, "saved-commands.json"));
    let applied = 0;
    const result = await store.replaceFromRecordsWith(
      { "machine:lab": { value: { name: "lab" } } },
      undefined,
      async (available) => {
        expect(available).toBe(false);
        applied++;
      },
    );
    expect(result).toBe(false);
    expect(applied).toBe(1);
  } finally {
    warning.mockRestore();
  }
});

test("a stale-preview guard failure is pending too, and other records still apply", async () => {
  const dir = await tempDir();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = new SavedCommandStore(join(dir, "saved-commands.json"));
    const base = await store.save(template);
    await store.save({ ...template, name: "Concurrent local save" });
    const applied: boolean[] = [];
    const result = await store.replaceFromRecordsWith(
      {
        [`saved-command:${base.id}`]: {
          value: { ...base, name: "Synced replacement" },
        },
      },
      { [`saved-command:${base.id}`]: { value: base } },
      async (available) => {
        applied.push(available);
      },
    );
    expect(result).toBe(false);
    expect(applied).toEqual([false]);
    expect((await store.list()).map((command) => command.name).sort()).toEqual([
      "Concurrent local save",
      template.name,
    ]);
  } finally {
    warning.mockRestore();
  }
});

test("savePeerSyncRecords keeps saved-command state and clocks while applying other records", async () => {
  const dir = await tempDir();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const path = join(dir, "saved-commands.json");
    await mkdir(path);
    const priorSaved: Version = {
      clock: { a: 1 },
      value: { id: "abc", name: "prior" },
    };
    const state = {
      records: {
        "saved-command:abc": priorSaved,
        "machine:lab": { clock: { a: 1 }, value: { name: "old" } },
      } as Record<string, Version>,
      observed: { "saved-command:abc": "prior-hash" } as Record<string, string>,
    };
    let saves = 0;
    await savePeerSyncRecords(
      {
        state,
        vault: { unlocked: true },
        save: async () => {
          saves++;
        },
        savedCommands: new SavedCommandStore(path),
      },
      {
        "saved-command:abc": {
          clock: { a: 2 },
          value: { id: "abc", name: "new" },
        },
        "machine:lab": { clock: { a: 2 }, value: { name: "new" } },
      },
    );
    expect(saves).toBe(1);
    expect(state.records["machine:lab"]?.value).toEqual({ name: "new" });
    expect(state.records["saved-command:abc"]).toEqual(priorSaved);
    expect(state.observed["saved-command:abc"]).toBe("prior-hash");
  } finally {
    warning.mockRestore();
  }
});
