import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInventory } from "../src/inventory";
import { peerCommand } from "../src/peer/command";
import type { Peer } from "../src/peer/store";
import { hash, merge } from "../src/peer/sync";
import { serve } from "../src/serve";
import type { Inventory } from "../src/types";

setDefaultTimeout(30_000);

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "hcp-review-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "inventory.yaml");
  const inventory: Inventory = {
    version: 1,
    session: { ttl: "24h", database: join(root, "homelab.kdbx") },
    machines: {},
  };
  await saveInventory(path, inventory);
  const server = await serve({
    inventoryPath: path,
    configPath: `${path}.ssh_config`,
    port: 0,
    peerPort: 0,
    discover: false,
  });
  cleanup.push(() => server.stop());
  server.hub.state.name = name;
  await server.hub.save();
  return { server, path, root };
}

test("deletions propagate and delete-versus-edit conflicts never silently resurrect", () => {
  const local = randomUUID();
  const remote = randomUUID();
  const old = {
    "machine:nas": { clock: { [local]: 1 }, value: { name: "nas" } },
  };
  const deletion = { "machine:nas": { clock: { [local]: 2 }, value: null } };
  expect(merge(old, deletion, remote).records["machine:nas"]?.value).toBeNull();
  const edited = {
    "machine:nas": {
      clock: { [local]: 1, [remote]: 1 },
      value: { name: "nas", description: "edited" },
    },
  };
  expect(merge(deletion, edited, local).conflicts).toHaveLength(1);
});

test("saved-command sync is capability-negotiated and invalid records are isolated", async () => {
  const current = await fixture("Current");
  const saved = await current.server.hub.savedCommands.save({
    name: "Legacy-safe check",
    hosts: ["legacy"],
    argv: ["hostname"],
    parameters: [],
  });
  let offer: Record<string, unknown> | undefined;
  const requests = spyOn(current.server.hub, "peerRequest").mockImplementation(
    async (_peerId, action, payload) => {
      if (action === "snapshot") return {};
      if (action === "offer") {
        offer = payload as Record<string, unknown>;
        return {};
      }
      throw new Error(`Unexpected peer action: ${action}`);
    },
  );
  try {
    const legacyPreview = await current.server.hub.beginSync("legacy-peer");
    await current.server.hub.syncCommit(legacyPreview.id, {});
    const legacyRecords = offer?.records as Record<string, unknown>;
    expect(Object.keys(legacyRecords ?? {})).not.toContain(
      `saved-command:${saved.id}`,
    );
    expect(offer?.features).toEqual(["saved-commands"]);

    requests.mockImplementation(async (_peerId, action, payload) => {
      if (action === "snapshot")
        return {
          version: 2,
          vaultUnlocked: false,
          features: ["saved-commands"],
          records: {},
        };
      if (action === "offer") {
        offer = payload as Record<string, unknown>;
        return {};
      }
      throw new Error(`Unexpected peer action: ${action}`);
    });
    const supportedPreview = await current.server.hub.beginSync("current-peer");
    await current.server.hub.syncCommit(supportedPreview.id, {});
    const supportedRecords = offer?.records as Record<string, unknown>;
    expect(Object.keys(supportedRecords ?? {})).toContain(
      `saved-command:${saved.id}`,
    );

    const invalidPreview = await current.server.hub.preview(
      "incoming-peer",
      {
        "machine:legacy": {
          clock: { [randomUUID()]: 1 },
          value: { name: "legacy" },
        },
        "saved-command:bad key": { clock: {}, value: {} },
        "saved-command:future": {
          clock: { [randomUUID()]: 1 },
          value: {
            schemaVersion: 2,
            id: "future",
            name: "Future template",
            hosts: ["legacy"],
            argv: ["hostname"],
            parameters: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      },
      undefined,
      ["saved-commands"],
    );
    expect(invalidPreview.issues?.map((issue) => issue.id)).toEqual(
      expect.arrayContaining(["saved-command:bad key", "saved-command:future"]),
    );
    expect(invalidPreview.changes).toContain("machine:legacy");
  } finally {
    requests.mockRestore();
  }
});

test("sync preview refresh retains negotiated features and incoming issues", async () => {
  const current = await fixture("Current");
  const peerFeatures = ["saved-commands"];
  const issues = [{ id: "saved-command:bad", reason: "Invalid saved command" }];
  const preview = await current.server.hub.preview(
    "incoming-peer",
    {},
    false,
    peerFeatures,
    issues,
  );
  const launch = JSON.parse(await readFile(current.server.launch, "utf8")) as {
    token: string;
  };
  const connect = await fetch(`${current.server.url}/api/connect`, {
    method: "POST",
    headers: {
      Origin: current.server.url,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: launch.token }),
  });
  const cookie = connect.headers.get("set-cookie")?.split(";")[0] ?? "";
  const refreshed = await fetch(`${current.server.url}/api/sync/preview`, {
    method: "POST",
    headers: {
      Origin: current.server.url,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: preview.id }),
  });
  expect(refreshed.status).toBe(200);
  const result = (await refreshed.json()) as {
    id: string;
    issues: { id: string; reason: string }[];
  };
  expect(result.issues).toContainEqual({
    id: "saved-command:bad",
    reason: "Invalid saved command",
  });
  expect(current.server.hub.pending.get(result.id)?.peerFeatures).toEqual(
    peerFeatures,
  );
});

test("invalid local saved commands are preserved and excluded from sync snapshots", async () => {
  const current = await fixture("Current");
  const saved = await current.server.hub.savedCommands.save({
    name: "Snapshot-safe check",
    hosts: ["legacy"],
    argv: ["hostname"],
    parameters: [],
  });
  const id = `saved-command:${saved.id}`;
  const prior = {
    clock: { [current.server.hub.state.id]: 1 },
    value: saved,
    at: Date.now(),
  };
  current.server.hub.state.records[id] = prior;
  current.server.hub.state.observed[id] = hash(saved);
  const invalid = { ...saved, name: "x".repeat(81) };
  await writeFile(
    current.server.hub.savedCommands.path,
    JSON.stringify({ version: 1, commands: { [saved.id]: invalid } }),
  );

  const snapshot = await current.server.hub.snapshot();

  expect(snapshot[id]).toBeUndefined();
  expect(current.server.hub.state.records[id]).toEqual(prior);
  expect(current.server.hub.state.observed[id]).toBe(hash(saved));
  await current.server.hub.savedCommands.save({
    name: "Second snapshot-safe check",
    hosts: ["legacy"],
    argv: ["hostname"],
    parameters: [],
  });
  const disk = JSON.parse(
    await readFile(current.server.hub.savedCommands.path, "utf8"),
  ) as { commands: Record<string, unknown> };
  expect(disk.commands[saved.id]).toEqual(invalid);
});

test("peer approval queueing normalizes argv and keeps policy errors on audit failure", async () => {
  const queued = await fixture("Execution device");
  await saveInventory(queued.path, {
    version: 1,
    session: { ttl: "24h", database: join(queued.root, "vault.kdbx") },
    machines: {
      example: { description: "Synthetic", transport: "local", access: "full" },
    },
  });
  const peer: Peer = {
    id: randomUUID(),
    name: "Remote device",
    platform: "test",
    address: "127.0.0.1",
    key: "",
    permissions: {
      sync: true,
      diagnostics: false,
      administer: true,
      operations: ["example"],
    },
    pairedAt: Date.now(),
  };
  const queuedResult = await peerCommand(queued.server.hub, peer, {
    host: "example",
    argv: [
      "rm",
      "--token={{tok}}",
      ...Array.from({ length: 69 }, (_, index) => `item-${index}`),
    ],
  });
  expect(queuedResult).toMatchObject({ pending: true });
  const audit = (
    await readFile(join(queued.root, "control-plane", "audit.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { event: { event: string; argv: string[] } },
    );
  expect(audit[0]?.event.argv).toHaveLength(64);
  expect(audit[0]?.event.argv[1]).toBe("--token=[REDACTED]");
  expect(audit[0]?.event.argv.at(-1)).toBe("[truncated 8 arguments]");
  await queued.server.hub.decideOperation(
    (queuedResult as { id: string }).id,
    false,
  );
  const rejectedAudit = await readFile(
    join(queued.root, "control-plane", "audit.jsonl"),
    "utf8",
  );
  expect(rejectedAudit).toContain('"event":"command.refused"');
  expect(rejectedAudit).toContain("--token=[REDACTED]");
  expect(rejectedAudit).not.toContain("{{tok}}");

  const refused = await fixture("Execution device");
  await saveInventory(refused.path, {
    version: 1,
    session: { ttl: "24h", database: join(refused.root, "vault.kdbx") },
    machines: {
      example: {
        description: "Synthetic",
        transport: "local",
        access: "observe",
      },
    },
  });
  const refusedPeer = { ...peer, id: randomUUID() };
  const auditPath = join(refused.root, "control-plane", "audit.jsonl");
  await mkdir(join(refused.root, "control-plane"), { recursive: true });
  await writeFile(auditPath, "not valid JSON\n");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(
      peerCommand(refused.server.hub, refusedPeer, {
        host: "example",
        argv: ["rm", "fixture"],
      }),
    ).rejects.toThrow("observe tier");
  } finally {
    warning.mockRestore();
  }
});

test("peer policy refusals can journal redacted token placeholders", async () => {
  const current = await fixture("Execution device");
  await saveInventory(current.path, {
    version: 1,
    session: { ttl: "24h", database: join(current.root, "vault.kdbx") },
    machines: {
      example: {
        description: "Synthetic",
        transport: "local",
        access: "observe",
      },
    },
  });
  const peer: Peer = {
    id: randomUUID(),
    name: "Remote device",
    platform: "test",
    address: "127.0.0.1",
    key: "",
    permissions: {
      sync: true,
      diagnostics: false,
      administer: true,
      operations: ["example"],
    },
    pairedAt: Date.now(),
  };

  await expect(
    peerCommand(current.server.hub, peer, {
      host: "example",
      argv: ["rm", "--token={{tok}}"],
    }),
  ).rejects.toThrow("observe tier");
  const journal = await readFile(
    join(current.root, "control-plane", "audit.jsonl"),
    "utf8",
  );
  expect(journal).toContain('"event":"command.refused"');
  expect(journal).toContain("--token=[REDACTED]");
  expect(journal).not.toContain("{{tok}}");
});

test("failed saved-command acquisition leaves peer apply state and files untouched", async () => {
  const current = await fixture("Current");
  const knownHosts = join(current.root, "known_hosts");
  const configPath = `${current.path}.ssh_config`;
  await writeFile(knownHosts, "known host fixture\n");
  await writeFile(configPath, "ssh config fixture\n");
  const beforeInventory = await readFile(current.path, "utf8");
  const beforeRecords = structuredClone(current.server.hub.state.records);
  const beforeObserved = structuredClone(current.server.hub.state.observed);
  const validate = spyOn(
    current.server.hub.savedCommands,
    "validateReplacement",
  ).mockRejectedValue(new Error("Saved command validation failed"));
  try {
    await expect(current.server.hub.applyRecords({})).rejects.toThrow(
      "Saved command validation failed",
    );
    expect(await readFile(current.path, "utf8")).toBe(beforeInventory);
    expect(await readFile(configPath, "utf8")).toBe("ssh config fixture\n");
    expect(await readFile(knownHosts, "utf8")).toBe("known host fixture\n");
    expect(current.server.hub.state.records).toEqual(beforeRecords);
    expect(current.server.hub.state.observed).toEqual(beforeObserved);
  } finally {
    validate.mockRestore();
  }
});

test("a later peer-state failure cannot replace saved commands", async () => {
  const current = await fixture("Current");
  const existing = await current.server.hub.savedCommands.save({
    name: "Existing shortcut",
    hosts: ["example"],
    argv: ["hostname"],
    parameters: [],
  });
  const savedCommandsPath = current.server.hub.savedCommands.path;
  const beforeSavedCommands = await readFile(savedCommandsPath, "utf8");
  const beforeRecords = structuredClone(current.server.hub.state.records);
  const beforeObserved = structuredClone(current.server.hub.state.observed);
  const timestamp = new Date().toISOString();
  const incoming = {
    schemaVersion: 1,
    id: "remote-shortcut",
    name: "Remote shortcut",
    hosts: ["example"],
    argv: ["hostname", "-f"],
    parameters: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const save = spyOn(current.server.hub, "save").mockRejectedValueOnce(
    new Error("injected peer-state persistence failure"),
  );
  try {
    await expect(
      current.server.hub.applyRecords({
        "saved-command:remote-shortcut": {
          clock: { [randomUUID()]: 1 },
          value: incoming,
        },
      }),
    ).rejects.toThrow("injected peer-state persistence failure");
    expect(await readFile(savedCommandsPath, "utf8")).toBe(beforeSavedCommands);
    expect(await current.server.hub.savedCommands.list()).toEqual([existing]);
    expect(current.server.hub.state.records).toEqual(beforeRecords);
    expect(current.server.hub.state.observed).toEqual(beforeObserved);
  } finally {
    save.mockRestore();
  }
});

test("peer approval and rejection state survives audit append failures", async () => {
  const current = await fixture("Execution device");
  await saveInventory(current.path, {
    version: 1,
    session: { ttl: "24h", database: join(current.root, "vault.kdbx") },
    machines: {
      example: {
        description: "Synthetic",
        transport: "local",
        access: "full",
      },
    },
  });
  const peer: Peer = {
    id: randomUUID(),
    name: "Remote device",
    platform: "test",
    address: "127.0.0.1",
    key: "",
    permissions: {
      sync: true,
      diagnostics: false,
      administer: true,
      operations: ["example"],
    },
    pairedAt: Date.now(),
  };
  current.server.hub.state.peers[peer.id] = peer;
  await mkdir(join(current.root, "control-plane"), { recursive: true });
  await writeFile(
    join(current.root, "control-plane", "audit.jsonl"),
    "not valid JSON\n",
  );
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await peerCommand(current.server.hub, peer, {
      host: "example",
      argv: ["rm", "fixture"],
    });
    expect(result).toMatchObject({ pending: true });
    const id = (result as { id: string }).id;
    expect(current.server.hub.operations.get(id)?.state).toBe("pending");
    expect(await current.server.hub.decideOperation(id, false)).toEqual({
      rejected: true,
    });
    expect(current.server.hub.operations.get(id)?.state).toBe("rejected");
    expect(warning).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});
