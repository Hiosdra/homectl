// Restore of a reset client (homelab #21 W5, D6A): preview, owner-only restore
// with step-up and a reason, verification before retirement, a fresh identity
// on the reset device, delivery that the device acknowledges, a decline that
// leaves no stale identity, and an audit trail with no plaintext.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { channelRequest } from "../src/workspace/channel";
import { takeRestore } from "../src/workspace/client-restore";
import { WorkspaceAudit } from "../src/workspace/audit";
import {
  clientId,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  SERVER_ADDRESS,
  stepUp,
} from "./workspace-helpers";

interface Preview {
  seq: number;
  verified: boolean;
  files: { path: string; size: number; restorable: boolean }[];
}

interface Issued {
  code: string;
  restore: { source: string; seq: number; files: number; bytes: number };
}

interface Joined {
  restore: {
    status: string;
    seq?: number;
    files?: string[];
    notes?: string[];
    reason?: string;
    acknowledged?: boolean;
  };
}

const CANARY = "hosts:\n  lab-canary-7f3a: {address: 10.9.9.9}\n";
let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function standardFiles() {
  return [
    { path: "inventory.yaml", data: bytes(CANARY) },
    { path: "known_hosts", data: bytes("lab ssh-ed25519 AAAA\n") },
    { path: "policy.json", data: bytes('{"rules":[]}\n') },
  ];
}

function owner(password = OWNER_PASSWORD) {
  return { password };
}

async function previewOf(client: string, seq?: number) {
  return (await h.server.owner(
    "/v1/owner/workspace/restore-preview",
    { client, reason: "reset check", ...owner(), ...(seq ? { seq } : {}) },
    stepUp,
  )) as Preview;
}

async function issue(client: string, seq: number) {
  return (await h.server.owner(
    "/v1/owner/workspace/restore",
    { client, seq, reason: "laptop reset", ...owner() },
    stepUp,
  )) as Issued;
}

async function joinWith(
  device: Awaited<ReturnType<Harness["freshDevice"]>>,
  code: string,
) {
  return (await device.client.owner(
    "/v1/owner/workspace/join",
    {
      address: SERVER_ADDRESS,
      code,
      remoteApproval: false,
      ...owner(),
    },
    stepUp,
  )) as Joined;
}

async function files(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

async function rejectionCode(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: number }).code ?? -1;
  }
  return 0;
}

test("a reset client receives the restored state under a fresh identity", async () => {
  await link(h);
  const oldId = await clientId(h);
  h.files = standardFiles();
  expect((await h.client.backupOnce())?.seq).toBe(1);

  const preview = await previewOf(oldId);
  expect(preview.verified).toBe(true);
  expect(preview.seq).toBe(1);
  expect(preview.files.map((f) => f.path)).toEqual([
    "inventory.yaml",
    "known_hosts",
    "policy.json",
  ]);
  expect(preview.files.every((f) => f.restorable)).toBe(true);
  expect(preview.files[0]?.size).toBe(CANARY.length);

  const issued = await issue(oldId, 1);
  expect(issued.restore).toMatchObject({ source: oldId, seq: 1, files: 3 });

  // The old identity is gone from the server and cannot sync again.
  const before = await h.serverState();
  expect(before.clients[oldId]).toBeUndefined();
  expect(before.removed).toContain(oldId);
  expect(before.retired?.[oldId]?.cause).toBe("restore");
  await expect(h.client.syncOnce()).rejects.toThrow("Unknown workspace client");

  const device = await h.freshDevice("reset-laptop");
  const joined = await joinWith(device, issued.code);
  expect(joined.restore).toMatchObject({
    status: "restored",
    seq: 1,
    files: ["inventory.yaml", "known_hosts", "policy.json"],
    acknowledged: true,
  });
  expect(joined.restore.notes).toEqual([
    "This client reported no revocations, so none were reapplied to the restore.",
  ]);
  expect(device.restore.written.get("inventory.yaml")).toEqual(bytes(CANARY));

  const fresh = await device.clientLink();
  expect(fresh.id).not.toBe(oldId);
  expect(fresh.backup.key).not.toBe((await h.clientLink()).backup.key);
  const after = await h.serverState();
  expect(after.clients[fresh.id]).toBeDefined();
  // Acknowledged: the grant is gone, so a second check finds nothing.
  expect(after.clients[fresh.id]?.restore).toBeUndefined();
  expect(fresh.restore).toBeUndefined();
  const again = await takeRestore(
    () => h.post,
    fresh,
    device.restore,
    async () => undefined,
  );
  expect(again.status).toBe("none");
});

test("preview and restore refuse without the owner password", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();

  await expect(
    h.server.owner(
      "/v1/owner/workspace/restore-preview",
      { client: id, reason: "check", password: "wrong" },
      stepUp,
    ),
  ).rejects.toThrow("Confirm with the owner password");
  await expect(
    h.server.owner(
      "/v1/owner/workspace/restore",
      { client: id, seq: 1, reason: "check" },
      stepUp,
    ),
  ).rejects.toThrow("Confirm with the owner password");

  const state = await h.serverState();
  expect(state.clients[id]).toBeDefined();
  expect(state.removed).not.toContain(id);
});

test("preview and restore refuse without a reason", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();

  expect(
    await rejectionCode(() =>
      h.server.owner(
        "/v1/owner/workspace/restore-preview",
        { client: id, ...owner() },
        stepUp,
      ),
    ),
  ).toBe(3);
  expect(
    await rejectionCode(() =>
      h.server.owner(
        "/v1/owner/workspace/restore",
        { client: id, seq: 1, reason: "   ", ...owner() },
        stepUp,
      ),
    ),
  ).toBe(3);

  const state = await h.serverState();
  expect(state.clients[id]).toBeDefined();
  expect(state.removed).not.toContain(id);
});

test("a tampered snapshot is refused and the source stays linked", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();

  // Flip one byte in a stored chunk: authenticated decryption must fail.
  const chunks = await files(join(h.serverDir, "workspace-backups", "chunks"));
  const target = chunks[0];
  expect(target).toBeDefined();
  const data = new Uint8Array(await readFile(target as string));
  data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
  await writeFile(target as string, data);

  expect((await previewOf(id)).verified).toBe(false);
  expect(await rejectionCode(() => issue(id, 1))).toBe(5);

  const state = await h.serverState();
  expect(state.clients[id]).toBeDefined();
  expect(state.removed).not.toContain(id);
  expect(state.retired?.[id]).toBeUndefined();
});

test("a file outside the restorable set is not delivered", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = [
    ...standardFiles(),
    { path: "scratch/notes.txt", data: bytes("not restorable\n") },
  ];
  await h.client.backupOnce();

  const preview = await previewOf(id);
  expect(
    preview.files.find((f) => f.path === "scratch/notes.txt")?.restorable,
  ).toBe(false);

  const issued = await issue(id, 1);
  expect(issued.restore.files).toBe(3);
  const device = await h.freshDevice("reset-b");
  await joinWith(device, issued.code);
  expect([...device.restore.written.keys()].sort()).toEqual([
    "inventory.yaml",
    "known_hosts",
    "policy.json",
  ]);
});

test("a device that already holds a restorable file declines: its fresh identity is discarded and the owner issues the restore again", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();
  const issued = await issue(id, 1);

  const device = await h.freshDevice("occupied");
  device.restore.taken.push("inventory.yaml");
  // Any request waits for the client to persist its identity first.
  await device.client.owner("/v1/owner/workspace/status", {}, stepUp);
  const before = await device.clientLink();
  const joined = await joinWith(device, issued.code);
  expect(joined.restore.status).toBe("refused");
  expect(joined.restore.reason).toContain("inventory.yaml");
  expect(joined.restore.reason).toContain("issue the restore again");
  expect(device.restore.written.size).toBe(0);

  // Unlinked automatically, with a new identity the server never honours.
  const unlinked = await device.clientLink();
  expect(unlinked.server).toBeUndefined();
  expect(unlinked.id).not.toBe(before.id);
  const state = await h.serverState();
  expect(state.clients[before.id]).toBeUndefined();
  expect(state.removed).toContain(before.id);
  expect(state.retired?.[before.id]?.cause).toBe("declined");

  // The owner moves on: the restore is issued again and the device joins anew.
  device.restore.taken.splice(0);
  const again = await issue(id, 1);
  const rejoined = await joinWith(device, again.code);
  expect(rejoined.restore.status).toBe("restored");
  expect(device.restore.written.get("inventory.yaml")).toEqual(bytes(CANARY));
});

test("a failed write is not a lost restore: the same identity fetches it again on its next sync", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();
  const issued = await issue(id, 1);

  const device = await h.freshDevice("retry");
  device.restore.failWrites = 1;
  const joined = await joinWith(device, issued.code);
  expect(joined.restore.status).toBe("failed");
  expect(joined.restore.reason).toContain("Disk write failed");
  expect(device.restore.written.size).toBe(0);

  // The grant was not consumed: the server still holds it for this identity.
  const fresh = await device.clientLink();
  expect((await h.serverState()).clients[fresh.id]?.restore).toBeDefined();
  expect(fresh.restorePending).toBe(true);

  await device.client.syncOnce();
  expect(device.restore.written.get("inventory.yaml")).toEqual(bytes(CANARY));
  expect((await h.serverState()).clients[fresh.id]?.restore).toBeUndefined();
  expect((await device.clientLink()).restorePending).toBeUndefined();

  const audit = new WorkspaceAudit(join(h.serverDir, "workspace-audit.jsonl"));
  const actions = (await audit.read()).map((entry) => entry.action);
  expect(
    actions.filter((action) => action === "restore.delivered"),
  ).toHaveLength(2);
  expect(
    actions.filter((action) => action === "restore.acknowledged"),
  ).toHaveLength(1);
});

test("a lost acknowledgment is repaired without fetching or writing again", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();
  const issued = await issue(id, 1);

  // Messages on this join: backup key, restore status, fetch, acknowledgment.
  // The fourth one is lost on the way back.
  const device = await h.freshDevice("lost-ack");
  const transport = h.post;
  let messages = 0;
  h.post = (path, value) => {
    if (path === "/v1/workspace/message" && ++messages === 4)
      return Promise.reject(new Error("connection reset"));
    return transport(path, value);
  };
  let joined: Joined;
  try {
    joined = await joinWith(device, issued.code);
  } finally {
    h.post = transport;
  }
  expect(joined.restore.status).toBe("restored");
  expect(joined.restore.acknowledged).toBe(false);
  const fresh = await device.clientLink();
  expect(fresh.restore?.seq).toBe(1);
  expect((await h.serverState()).clients[fresh.id]?.restore).toBeDefined();

  await device.client.syncOnce();
  expect((await h.serverState()).clients[fresh.id]?.restore).toBeUndefined();
  expect((await device.clientLink()).restore).toBeUndefined();

  const audit = new WorkspaceAudit(join(h.serverDir, "workspace-audit.jsonl"));
  const actions = (await audit.read()).map((entry) => entry.action);
  expect(
    actions.filter((action) => action === "restore.delivered"),
  ).toHaveLength(1);
  expect(
    actions.filter((action) => action === "restore.acknowledged"),
  ).toHaveLength(1);
});

test("only the identity holding a grant can take it; the revoked source cannot", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();
  const issued = await issue(id, 1);
  const device = await h.freshDevice("holder");
  await joinWith(device, issued.code);

  const source = await h.clientLink();
  expect(source.server).toBeDefined();
  await expect(
    channelRequest(
      h.post,
      source.id,
      { id: source.server?.id ?? "", key: source.server?.key ?? "" },
      "restore.fetch",
      {},
    ),
  ).rejects.toThrow("Unknown workspace client");
});

test("a grant expires unused: nothing is delivered after the window", async () => {
  let clock = 1_000_000;
  await h.cleanup();
  h = await fixture({ serverNow: () => clock, clientNow: () => clock });
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();
  const issued = await issue(id, 1);

  const device = await h.freshDevice("late");
  device.restore.failWrites = 1;
  await joinWith(device, issued.code);
  clock += 11 * 60_000;

  // The join fetched the files before its write failed: that one delivery is
  // audited. After the window, the sync delivers nothing more.
  await device.client.syncOnce();
  expect(device.restore.written.size).toBe(0);
  const fresh = await device.clientLink();
  expect(fresh.restorePending).toBeUndefined();
  const audit = new WorkspaceAudit(join(h.serverDir, "workspace-audit.jsonl"));
  const actions = (await audit.read()).map((entry) => entry.action);
  expect(
    actions.filter((action) => action === "restore.delivered"),
  ).toHaveLength(1);
  expect(
    actions.filter((action) => action === "restore.acknowledged"),
  ).toHaveLength(0);
});

test("the history of a revoked client stays restorable", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();
  await issue(id, 1);
  const preview = await previewOf(id);
  expect(preview.verified).toBe(true);
  expect(preview.seq).toBe(1);
});

test("every decryption and restore step is audited without plaintext", async () => {
  await link(h);
  const id = await clientId(h);
  h.files = standardFiles();
  await h.client.backupOnce();
  await previewOf(id);
  const issued = await issue(id, 1);
  const device = await h.freshDevice("audited");
  await joinWith(device, issued.code);

  const audit = new WorkspaceAudit(join(h.serverDir, "workspace-audit.jsonl"));
  const check = await audit.verify();
  expect(check.ok).toBe(true);
  const actions = (await audit.read()).map((entry) => entry.action);
  expect(actions).toEqual([
    "restore.previewed",
    "client.revoked",
    "restore.issued",
    "restore.delivered",
    "restore.acknowledged",
  ]);
  const text = await readFile(
    join(h.serverDir, "workspace-audit.jsonl"),
    "utf8",
  );
  expect(text).not.toContain("lab-canary-7f3a");
  expect(text).toContain("laptop reset");
});
