import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePeerSyncRecords } from "../src/peer/apply-sync-records";
import type { Version } from "../src/peer/store";
import { SavedCommandStore } from "../src/saved-commands";

test("failed saved-command replacement applies other records and keeps its clock pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-peer-sync-records-"));
  const store = new SavedCommandStore(join(dir, "saved-commands.json"));
  const saved = await store.save({
    name: "Local shortcut",
    hosts: ["nas"],
    argv: ["hostname"],
    parameters: [],
  });
  const savedId = `saved-command:${saved.id}`;
  const peerId = "11111111-1111-4111-8111-111111111111";
  const previousSaved: Version = {
    clock: { [peerId]: 2 },
    value: saved,
    at: 1000,
  };
  const incomingSaved: Version = {
    clock: { [peerId]: 3 },
    value: { ...saved, name: "Remote shortcut" },
    at: 2000,
  };
  const machine: Version = {
    clock: { [peerId]: 1 },
    value: { name: "nas" },
    at: 1000,
  };
  const observedSaved = "preserve-this-observation";
  const state = {
    records: { [savedId]: previousSaved },
    observed: { [savedId]: observedSaved },
  };
  const write = spyOn(
    store as unknown as { write: (value: unknown) => Promise<void> },
    "write",
  ).mockRejectedValueOnce(new Error("saved-command disk failure"));
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  let fileWrites = 0;
  let stateSaves = 0;

  try {
    await savePeerSyncRecords(
      {
        state,
        vault: { unlocked: false },
        save: async () => {
          stateSaves++;
        },
        savedCommands: store,
      },
      {
        [savedId]: incomingSaved,
        "machine:nas": machine,
      },
      { [savedId]: { value: saved } },
      async () => {
        fileWrites++;
      },
    );

    expect(fileWrites).toBe(1);
    expect(stateSaves).toBe(1);
    expect(state.records[savedId]).toEqual(previousSaved);
    expect(state.observed[savedId]).toBe(observedSaved);
    expect(state.records["machine:nas"]).toEqual(machine);
    expect((await store.list()).map((command) => command.id)).toEqual([
      saved.id,
    ]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Saved commands were left unchanged"),
    );
  } finally {
    write.mockRestore();
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sync apply preserves a locally invalid command without publishing its deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-peer-sync-invalid-local-"));
  const path = join(dir, "saved-commands.json");
  const store = new SavedCommandStore(path);
  const saved = await store.save({
    name: "Previously valid command",
    hosts: ["nas"],
    argv: ["hostname"],
    parameters: [],
  });
  const savedId = `saved-command:${saved.id}`;
  const peerId = "22222222-2222-4222-8222-222222222222";
  const previousSaved: Version = {
    clock: { [peerId]: 2 },
    value: saved,
    at: 1000,
  };
  const staleSaved: Version = {
    clock: { [peerId]: 1 },
    value: { ...saved, name: "Stale synced name" },
    at: 900,
  };
  const machine: Version = {
    clock: { [peerId]: 3 },
    value: { name: "nas" },
    at: 1100,
  };
  const state = {
    records: { [savedId]: previousSaved },
    observed: { [savedId]: "previous-observation" },
  };
  const disk = JSON.parse(await readFile(path, "utf8")) as {
    commands: Record<string, Record<string, unknown>>;
  };
  disk.commands[saved.id] = { ...saved, name: "x".repeat(81) };
  await writeFile(
    path,
    JSON.stringify({ version: 1, commands: disk.commands }),
  );

  try {
    await savePeerSyncRecords(
      {
        state,
        vault: { unlocked: false },
        save: async () => {},
        savedCommands: store,
      },
      { [savedId]: staleSaved, "machine:nas": machine },
      { [savedId]: { value: saved } },
    );

    const commands = await store.listWithIssues();
    const preservedDisk = JSON.parse(await readFile(path, "utf8")) as {
      commands: Record<string, Record<string, unknown>>;
    };
    expect(commands.invalid.map((issue) => issue.id)).toContain(saved.id);
    expect(preservedDisk.commands[saved.id]?.name).toBe("x".repeat(81));
    expect(state.records[savedId]).toEqual(previousSaved);
    expect(state.records[savedId]?.value).not.toBeNull();
    expect(state.observed[savedId]).toBe("previous-observation");
    expect(state.records["machine:nas"]).toEqual(machine);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
