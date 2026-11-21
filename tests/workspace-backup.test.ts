// Encrypted backups over the workspace channel (homelab #21 §6): upload,
// chunk reuse, client binding of manifests, and no plaintext on the server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildSnapshot, newClientKey } from "../src/backup";
import { channelRequest } from "../src/workspace/channel";
import { backupClientId } from "../src/workspace/state";
import {
  clientId,
  fixture,
  type Harness,
  link,
  stepUp,
} from "./workspace-helpers";

let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

async function filesUnder(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test("a backup run uploads, and a second run reuses every chunk", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = [
    { path: "inventory.yaml", data: bytes("inventory body ".repeat(50)) },
    { path: "policy.json", data: bytes("{}\n") },
  ];
  const first = await h.client.backupOnce();
  expect(first?.seq).toBe(1);
  expect(first?.uploaded).toBeGreaterThan(0);

  const second = await h.client.backupOnce();
  expect(second?.seq).toBe(2);
  expect(second?.uploaded).toBe(0);
  expect(second?.reused).toBeGreaterThan(0);

  const clients = (await h.server.owner(
    "/v1/owner/workspace/clients",
    {},
    stepUp,
  )) as { id: string; backup: { latestSeq: number | null } }[];
  expect(clients.find((item) => item.id === id)?.backup.latestSeq).toBe(2);
  const linkState = await h.clientLink();
  expect(linkState.backup.seq).toBe(2);
  expect(linkState.backup.lastError).toBeUndefined();
});

test("a manifest header naming another client is refused", async () => {
  await link(h);
  const id = await clientId(h);
  const linkState = await h.clientLink();
  const other = "c-00000000-0000-4000-8000-000000000000";
  expect(other).not.toBe(backupClientId(id));
  const snapshot = buildSnapshot([{ path: "a.txt", data: bytes("hello") }], {
    client: other,
    key: newClientKey(),
    seq: 1,
    parent: null,
    now: Date.now(),
  });
  await expect(
    channelRequest(
      h.post,
      id,
      { id: linkState.server?.id ?? "", key: linkState.server?.key ?? "" },
      "backup.commit",
      { header: snapshot.header, sealed: snapshot.sealed },
    ),
  ).rejects.toThrow("belongs to another client");
});

test("the server's backup store never holds plaintext", async () => {
  await link(h);
  const canary = `CANARY-${randomUUID()}-plaintext-marker`;
  h.files = [
    { path: "inventory.yaml", data: bytes(canary.repeat(300)) },
    { path: "known_hosts", data: bytes(`${canary} host key line\n`) },
  ];
  expect((await h.client.backupOnce())?.uploaded).toBeGreaterThan(0);

  const stored = await filesUnder(join(h.serverDir, "workspace-backups"));
  expect(stored.length).toBeGreaterThan(0);
  const marker = Buffer.from(canary);
  for (const path of stored) {
    const data = await readFile(path);
    expect(data.includes(marker)).toBe(false);
  }
  // The rest of the server state directory holds no plaintext either.
  for (const path of await filesUnder(h.serverDir)) {
    const data = await readFile(path);
    expect(data.includes(marker)).toBe(false);
  }
});
