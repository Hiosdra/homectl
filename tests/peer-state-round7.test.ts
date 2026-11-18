import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePeerSyncRecords } from "../src/peer/apply-sync-records";
import {
  loadState,
  type PeerState,
  saveState,
  type Version,
} from "../src/peer/store";
import { SavedCommandStore } from "../src/saved-commands";

test("keeps saved-command sync state out of peers.json during sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-peer-state-split-"));
  try {
    const peerFile = join(dir, "peers.json");
    const savedStore = new SavedCommandStore(join(dir, "saved-commands.json"));
    const command = await savedStore.save({
      name: "Show host",
      hosts: ["nas"],
      argv: ["hostname"],
      parameters: [],
    });
    const state: PeerState = {
      version: 1,
      id: randomUUID(),
      name: "Local",
      key: "local-key",
      peers: {},
      records: {},
      observed: {},
    };
    const version = (value: unknown): Version => ({
      clock: { [state.id]: 1 },
      value,
      at: 1000,
    });
    const records: Record<string, Version> = {
      "machine:nas": version({ name: "nas" }),
      "provider:cloud": version({ name: "cloud" }),
      "credential:session": version({ secret: "not persisted" }),
      "hostkey:nas": version("nas ssh-ed25519 AQID"),
      [`saved-command:${command.id}`]: version(command),
    };

    await savePeerSyncRecords(
      {
        state,
        vault: { unlocked: true },
        savedCommands: savedStore,
        save: () => saveState(peerFile, state),
      },
      records,
    );

    const peerDisk = JSON.parse(await readFile(peerFile, "utf8")) as {
      records: Record<string, Version>;
      observed: Record<string, string>;
    };
    const savedDisk = JSON.parse(
      await readFile(join(dir, "peers-saved-commands.json"), "utf8"),
    ) as { records: Record<string, Version>; observed: Record<string, string> };
    expect(Object.keys(peerDisk.records).sort()).toEqual([
      "credential:session",
      "hostkey:nas",
      "machine:nas",
      "provider:cloud",
    ]);
    expect(Object.keys(peerDisk.observed).sort()).toEqual([
      "credential:session",
      "hostkey:nas",
      "machine:nas",
      "provider:cloud",
    ]);
    expect(Object.keys(savedDisk.records)).toEqual([
      `saved-command:${command.id}`,
    ]);
    expect(Object.keys(savedDisk.observed)).toEqual([
      `saved-command:${command.id}`,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates legacy saved-command peer keys out of peers.json on read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-peer-state-migrate-"));
  try {
    const peerFile = join(dir, "peers.json");
    const peerId = randomUUID();
    const savedId = "saved-command:legacy";
    const savedVersion: Version = {
      clock: { [peerId]: 3 },
      value: { legacy: true },
      at: 3000,
    };
    await writeFile(
      peerFile,
      JSON.stringify({
        version: 1,
        id: peerId,
        name: "Old peer state",
        key: "peer-key",
        peers: {},
        records: {
          "machine:nas": { clock: { [peerId]: 1 }, value: { name: "nas" } },
          [savedId]: savedVersion,
        },
        observed: { "machine:nas": "machine-hash", [savedId]: "saved-hash" },
      }),
    );

    const loaded = await loadState(peerFile);
    const peerDisk = JSON.parse(await readFile(peerFile, "utf8")) as {
      records: Record<string, Version>;
      observed: Record<string, string>;
    };
    const savedDisk = JSON.parse(
      await readFile(join(dir, "peers-saved-commands.json"), "utf8"),
    ) as { records: Record<string, Version>; observed: Record<string, string> };
    expect(loaded.records[savedId]).toEqual(savedVersion);
    expect(peerDisk.records).toHaveProperty("machine:nas");
    expect(peerDisk.records).not.toHaveProperty(savedId);
    expect(peerDisk.observed).not.toHaveProperty(savedId);
    expect(savedDisk.records[savedId]).toEqual(savedVersion);
    expect(savedDisk.observed[savedId]).toBe("saved-hash");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
