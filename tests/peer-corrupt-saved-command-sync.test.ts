import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInventory } from "../src/inventory";
import { serve } from "../src/serve";
import { keyReference } from "../src/session/keys";

setDefaultTimeout(30_000);

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "homectl-corrupt-sync-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "inventory.yaml");
  await saveInventory(path, {
    version: 1,
    session: { ttl: "24h", database: join(root, "homelab.kdbx") },
    machines: {},
  });
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
  return { server, path };
}

test("a corrupt saved-command file disables only that sync feature", async () => {
  const { server, path } = await fixture("Corrupt saved commands");
  const saved = await server.hub.savedCommands.save({
    name: "Local shortcut",
    hosts: ["nas"],
    argv: ["hostname"],
    parameters: [],
  });
  await server.hub.snapshot(false);
  const savedId = `saved-command:${saved.id}`;
  const priorSavedRecord = structuredClone(server.hub.state.records[savedId]);
  const priorObserved = server.hub.state.observed[savedId];
  const savedPath = server.hub.savedCommands.path;
  const corrupt = "{ malformed saved-command data\n";
  await writeFile(savedPath, corrupt);

  await server.hub.vault.unlock("synthetic-sync-password", true);
  const privateKey = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  await server.hub.vault.apply({
    "homectl-nas": {
      title: "homectl-nas",
      fields: { Title: "homectl-nas" },
      attachments: { id_ed25519: Buffer.from(privateKey).toString("base64") },
    },
  });
  await saveInventory(path, {
    version: 1,
    session: { ttl: "24h", database: server.hub.vault.path },
    machines: {
      nas: {
        description: "Synthetic NAS",
        transport: "ssh",
        address: "192.0.2.10",
        user: "operator",
        ssh_alias: "nas",
        access: "observe",
        auth: keyReference("nas", path),
      },
    },
  });

  const snapshot = (await server.hub.remoteAction(
    {
      id: randomUUID(),
      name: "Sync peer",
      platform: "test",
      address: "127.0.0.1",
      key: "00",
      permissions: {
        sync: true,
        diagnostics: false,
        operations: [],
        administer: false,
      },
      pairedAt: Date.now(),
    },
    "snapshot",
    { version: 2, features: ["saved-commands"] },
  )) as {
    records: Record<string, unknown>;
    issues: { id: string; reason: string }[];
  };

  expect(snapshot.records["machine:nas"]).toBeDefined();
  expect(snapshot.records["credential:homectl-nas"]).toBeDefined();
  expect(snapshot.records[savedId]).toBeUndefined();
  expect(snapshot.issues).toContainEqual(
    expect.objectContaining({
      id: "saved-commands",
      reason: expect.stringContaining("corrupt"),
    }),
  );
  expect(server.hub.state.records[savedId]).toEqual(priorSavedRecord);
  expect(server.hub.state.observed[savedId]).toBe(priorObserved);
  expect(await readFile(savedPath, "utf8")).toBe(corrupt);
});
