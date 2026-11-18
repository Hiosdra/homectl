import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInventory } from "../src/inventory";
import { savePeerSyncRecords } from "../src/peer/apply-sync-records";
import { snapshotWithIssues } from "../src/peer/snapshot";
import {
  loadState,
  type PeerState,
  peerPath,
  savedCommandPeerStateUnreadable,
} from "../src/peer/store";
import { validateFields } from "../src/saved-command-validation";
import type { SavedCommandStore } from "../src/saved-commands";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const base = {
  name: "Credential check",
  hosts: ["example"],
  description: "Synthetic",
};

test.each([
  [["curl", "-u", "admin:hunter2", "https://nas/api"]],
  [["curl", "--user=admin:hunter2", "https://nas/api"]],
  [["mysql", "-phunter2", "-e", "select 1"]],
  [["sshpass", "-p", "hunter2", "ssh", "nas"]],
  [["git", "clone", "https://bob:hunter2@git.example/x"]],
])("saved commands refuse plaintext credentials: %p", (argv) => {
  expect(() => validateFields({ ...base, argv, parameters: [] })).toThrow(
    "Secret-like arguments",
  );
});

test.each([
  [["curl", "-u", "admin:{{pw}}", "https://nas/api"]],
  [["mysql", "-p{{pw}}", "-e", "select 1"]],
  [["sshpass", "-p", "{{pw}}", "ssh", "nas"]],
  [["git", "clone", "https://bob:{{pw}}@git.example/x"]],
])(
  "saved commands accept declared placeholders for credentials: %p",
  (argv) => {
    expect(() =>
      validateFields({ ...base, argv, parameters: [{ name: "pw" }] }),
    ).not.toThrow();
  },
);

test.each([
  [["sudo", "-u", "postgres", "psql"]],
  [["ssh", "-p", "2222", "nas"]],
  [["find", "/var/log", "-perm", "644", "-print"]],
  [["docker", "exec", "-u", "root", "app", "id"]],
  [["curl", "https://nas/api"]],
])("ordinary -u/-p uses stay allowed: %p", (argv) => {
  expect(() => validateFields({ ...base, argv, parameters: [] })).not.toThrow();
});

async function unreadableSidecarFixture() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-round9-"));
  cleanup.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await saveInventory(inventoryPath, {
    version: 1,
    session: { ttl: "24h", database: join(dir, "vault.kdbx") },
    machines: {},
  });
  const deviceId = randomUUID();
  await writeFile(
    peerPath(inventoryPath),
    JSON.stringify({
      version: 1,
      id: deviceId,
      name: "local",
      key: "k".repeat(64),
      peers: {},
      records: {},
      observed: {},
    }),
  );
  await writeFile(
    join(dir, "peers-saved-commands.json"),
    "{ truncated saved-command peer state",
  );
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const state = await loadState(peerPath(inventoryPath));
  warning.mockRestore();
  return { inventoryPath, state };
}

test("an unreadable sidecar disables saved-command capture in snapshots", async () => {
  const { inventoryPath, state } = await unreadableSidecarFixture();
  expect(savedCommandPeerStateUnreadable(inventoryPath)).toBe(true);
  const savedCommands = {
    listWithIssues: async () => ({
      commands: [{ id: "local-edit", name: "Local edit", argv: ["uname"] }],
      invalid: [],
    }),
  } as unknown as SavedCommandStore;
  const result = await snapshotWithIssues(
    {
      inventoryPath,
      state,
      savedCommands,
      vault: { unlocked: false, snapshot: () => ({}) },
      save: async () => {},
    },
    false,
  );
  expect(
    Object.keys(result.records).filter((id) => id.startsWith("saved-command:")),
  ).toEqual([]);
  expect(state.records["saved-command:local-edit"]).toBeUndefined();
  expect(result.issues.map((issue) => issue.id)).toContain("saved-commands");
});

test("an unreadable sidecar keeps incoming saved-command records out of the local file", async () => {
  const { inventoryPath, state } = await unreadableSidecarFixture();
  let replaced = false;
  let filesApplied = false;
  const context = {
    inventoryPath,
    state: state as Pick<PeerState, "records" | "observed">,
    vault: { unlocked: false },
    save: async () => {},
    savedCommands: {
      replaceFromRecordsWith: async () => {
        replaced = true;
        return true;
      },
    },
  };
  await savePeerSyncRecords(
    context,
    {
      "machine:lab": { clock: { remote: 1 }, value: { name: "lab" } },
      "saved-command:remote": {
        clock: { remote: 5 },
        value: { id: "remote", name: "Old remote copy" },
      },
    },
    undefined,
    async () => {
      filesApplied = true;
    },
  );
  expect(replaced).toBe(false);
  expect(filesApplied).toBe(true);
  expect(context.state.records["machine:lab"]).toBeDefined();
  expect(context.state.records["saved-command:remote"]).toBeUndefined();
});
