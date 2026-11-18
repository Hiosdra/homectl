import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedCommandStore } from "../src/saved-commands";

const template = {
  name: "Restart service",
  hosts: ["example"],
  argv: ["systemctl", "restart", "{{unit}}"],
  parameters: [{ name: "unit", description: "Service unit" }],
  description: "Restart one named service",
};

test("peer replacement holds the lock through all apply writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-sync-lock-"));
  try {
    const store = new SavedCommandStore(join(dir, "saved-commands.json"));
    const base = await store.save(template);
    const expected = { [`saved-command:${base.id}`]: { value: base } };
    const incoming = {
      ...base,
      name: "Synced replacement",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    let entered!: () => void;
    let release!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const applyGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replacing = store.replaceFromRecordsWith(
      { [`saved-command:${base.id}`]: { value: incoming } },
      expected,
      async (available) => {
        expect(available).toBe(true);
        entered();
        await applyGate;
      },
    );
    await callbackEntered;

    let localSaveFinished = false;
    const localSave = store
      .save({ ...template, name: "Concurrent local save" })
      .then(() => {
        localSaveFinished = true;
      });
    await Bun.sleep(10);
    expect(localSaveFinished).toBe(false);

    release();
    expect(await replacing).toBe(true);
    await localSave;
    expect((await store.list()).map((command) => command.name).sort()).toEqual([
      "Concurrent local save",
      "Synced replacement",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
