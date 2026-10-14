import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveInventory } from "../src/inventory";
import { open, seal } from "../src/peer/crypto";
import { defaults } from "../src/peer/store";
import { merge } from "../src/peer/sync";
import { credentialPublicKey } from "../src/peer/vault";
import { available } from "../src/platform";
import { serve } from "../src/serve";
import { systemdUnit, windowsServiceConfig } from "../src/service";
import { createKey, keyReference } from "../src/session/keys";
import type { Inventory } from "../src/types";

const a = randomUUID(),
  b = randomUUID();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "hcp-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "inventory.yaml");
  const inv: Inventory = {
    version: 1,
    session: { ttl: "24h", database: join(root, "homelab.kdbx") },
    machines: {},
  };
  await saveInventory(path, inv);
  const s = await serve({
    inventoryPath: path,
    configPath: `${path}.ssh_config`,
    port: 0,
    peerPort: 0,
    discover: false,
  });
  cleanup.push(() => s.stop());
  s.hub.state.name = name;
  await s.hub.save();
  return { s, path, root };
}
test("concurrent changes require explicit choices, join clocks, and preserve both", () => {
  const current = {
    "machine:nas": {
      clock: { [a]: 2, [b]: 1 },
      value: { name: "nas", description: "Linux" },
    },
  };
  const incoming = {
    "machine:nas": {
      clock: { [a]: 1, [b]: 2 },
      value: { name: "nas", description: "Windows" },
    },
  };
  expect(merge(current, incoming, a).conflicts).toHaveLength(1);
  const r = merge(current, incoming, a, { "machine:nas": "both" });
  expect(r.conflicts).toHaveLength(0);
  expect(r.copies).toHaveLength(1);
  expect(r.records["machine:nas"]?.clock).toEqual({ [a]: 3, [b]: 2 });
  expect(Object.values(r.records).map((r) => r.value)).toContainEqual({
    name: "nas",
    description: "Windows",
  });
});
test("deletions propagate and delete-versus-edit conflicts never silently resurrect", () => {
  const old = { "machine:nas": { clock: { [a]: 1 }, value: { name: "nas" } } };
  const deletion = { "machine:nas": { clock: { [a]: 2 }, value: null } };
  expect(merge(old, deletion, b).records["machine:nas"]?.value).toBeNull();
  const edited = {
    "machine:nas": {
      clock: { [a]: 1, [b]: 1 },
      value: { name: "nas", description: "edited" },
    },
  };
  expect(merge(deletion, edited, a).conflicts).toHaveLength(1);
});
test("authenticated encryption rejects tampering and context substitution", () => {
  const key = Buffer.alloc(32, 17);
  const e = seal(key, { secret: "synthetic" }, "test:request");
  expect(open<{ secret: string }>(key, e, "test:request")).toEqual({
    secret: "synthetic",
  });
  expect(() => open(key, e, "test:response")).toThrow();
  expect(() =>
    open(
      key,
      { ...e, tag: Buffer.alloc(16).toString("base64") },
      "test:request",
    ),
  ).toThrow();
});
test("real peers pair with PAKE, require both confirmations, and enforce grants", async () => {
  const first = await fixture("Linux"),
    second = await fixture("Windows");
  await first.s.hub.openPair();
  const code = first.s.hub.pair?.code ?? "";
  await second.s.hub.join(first.s.address, code);
  expect(first.s.hub.pair?.sas).toBe(second.s.hub.pair?.sas);
  await second.s.hub.confirm(defaults());
  expect(Object.keys(first.s.hub.state.peers)).toHaveLength(0);
  expect(Object.keys(second.s.hub.state.peers)).toHaveLength(0);
  await first.s.hub.confirm(defaults());
  await second.s.hub.pollPair();
  expect(Object.keys(first.s.hub.state.peers)).toHaveLength(1);
  expect(Object.keys(second.s.hub.state.peers)).toHaveLength(1);
  const peerId = first.s.hub.state.id;
  await expect(
    second.s.hub.peerRequest(peerId, "status", {}),
  ).rejects.toThrow();
  expect(await second.s.hub.peerRequest(peerId, "snapshot", {})).toEqual({});
  await first.s.hub.forget(second.s.hub.state.id);
  await expect(
    second.s.hub.peerRequest(peerId, "snapshot", {}),
  ).rejects.toThrow();
}, 30_000);
test("wrong pairing code invalidates the single attempt and stores no trust", async () => {
  const first = await fixture("Linux"),
    second = await fixture("Windows");
  await first.s.hub.openPair();
  await expect(
    second.s.hub.join(first.s.address, "9999-0000"),
  ).rejects.toThrow();
  expect(Object.keys(first.s.hub.state.peers)).toHaveLength(0);
  expect(first.s.hub.pair?.expiresAt).toBe(0);
  await expect(
    second.s.hub.join(first.s.address, first.s.hub.pair?.code ?? "1111-1111"),
  ).rejects.toThrow();
}, 30_000);
test("local panel refuses unauthenticated access and cross-origin mutation", async () => {
  const { s } = await fixture("Test");
  const unauth = await fetch(`${s.url}/api/state`);
  expect(unauth.status).toBe(403);
  const launch = JSON.parse(await readFile(s.launch, "utf8"));
  const denied = await fetch(`${s.url}/api/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://evil.invalid",
    },
    body: JSON.stringify({ token: launch.token }),
  });
  expect(denied.status).toBe(403);
  const connect = await fetch(`${s.url}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: s.url },
    body: JSON.stringify({ token: launch.token }),
  });
  expect(connect.status).toBe(200);
  const cookie = connect.headers.get("set-cookie")?.split(";")[0] ?? "";
  const state = await fetch(`${s.url}/api/state`, {
    headers: { Cookie: cookie },
  });
  expect(state.status).toBe(200);
  const csrf = await fetch(`${s.url}/api/pair/open`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: "http://evil.invalid",
    },
    body: "{}",
  });
  expect(csrf.status).toBe(403);
  expect(s.hub.pair).toBeUndefined();
  const rebinding = await fetch(`${s.url}/api/state`, {
    headers: { Cookie: cookie, Host: "evil.invalid" },
  });
  expect(rebinding.status).toBe(403);
});
test("credentials remain KDBX-encrypted at rest and sync reconstructs platform-local references", async () => {
  const first = await fixture("Linux"),
    second = await fixture("Windows");
  const pass = "synthetic-vault-only";
  await first.s.hub.vault.unlock(pass, true);
  await second.s.hub.vault.unlock(pass, true);
  const pair = generateKeyPairSync("ed25519");
  const key = pair.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const credential = {
    title: "homectl-nas",
    fields: { Title: "homectl-nas", Password: "synthetic-entry-only" },
    attachments: { id_ed25519: Buffer.from(key).toString("base64") },
  };
  await first.s.hub.vault.apply({ "homectl-nas": credential });
  await saveInventory(first.path, {
    version: 1,
    session: { ttl: "24h", database: first.s.hub.vault.path },
    machines: {
      nas: {
        description: "Synthetic NAS",
        transport: "ssh",
        address: "192.0.2.10",
        user: "operator",
        ssh_alias: "nas",
        access: "observe",
        auth: keyReference("nas", first.path),
      },
    },
  });
  const outgoing = await first.s.hub.snapshot();
  const p = await second.s.hub.preview(first.s.hub.state.id, outgoing);
  expect(p.conflicts).toHaveLength(0);
  await second.s.hub.commit(p.id, {});
  const received = JSON.parse(
    await Bun.file(second.path.replace("inventory.yaml", "peers.json")).text(),
  );
  expect(JSON.stringify(received)).not.toContain("synthetic-entry-only");
  expect(JSON.stringify(received)).not.toContain("BEGIN PRIVATE KEY");
  const disk = await readFile(second.s.hub.vault.path);
  expect(disk.includes(Buffer.from(key))).toBe(false);
  const inv = (await import("../src/inventory")).loadInventory;
  const actual = await inv(second.path);
  expect(actual.machines.nas?.auth?.socket).toBe(
    keyReference("nas", second.path).socket,
  );
  expect(actual.machines.nas?.auth?.public_key).toBe(
    keyReference("nas", second.path).public_key,
  );
  expect(
    await readFile(actual.machines.nas?.auth?.public_key ?? "", "utf8"),
  ).toBe(credentialPublicKey(credential));
  second.s.hub.vault.lock();
  await second.s.hub.vault.unlock(pass);
  expect(
    second.s.hub.vault.snapshot()["homectl-nas"]?.attachments.id_ed25519,
  ).toBe(credential.attachments.id_ed25519);
}, 30_000);
test("external KDBX changes stop save and stale sync previews stop apply", async () => {
  const { s, path } = await fixture("Linux");
  await s.hub.vault.unlock("synthetic", true);
  await writeFile(s.hub.vault.path, "external change");
  await expect(s.hub.vault.save()).rejects.toThrow("Database changed");
  const p = await s.hub.preview(b, {
    "machine:nas": {
      clock: { [b]: 1 },
      value: {
        name: "nas",
        description: "Synthetic",
        transport: "ssh",
        access: "observe",
        address: "192.0.2.1",
        user: "operator",
        ssh_alias: "nas",
        auth: { type: "keepassxc", entry: "homectl-nas" },
      },
    },
  });
  await saveInventory(path, {
    version: 1,
    machines: {
      local: {
        description: "Changed local",
        transport: "local",
        access: "user",
      },
    },
  });
  await expect(s.hub.commit(p.id, {})).rejects.toThrow();
});
test("service manifests quote paths, preserve systemd specifiers and never embed account passwords", () => {
  const unit = systemdUnit("/tmp/user%/inventory.yaml", "192.168.1.4");
  expect(unit).toContain("user%%");
  expect(unit).toContain("UMask=0077");
  const xml = windowsServiceConfig(
    "C:\\Users\\Example User\\inventory.yaml",
    "192.168.1.4",
  );
  expect(xml).toContain("&quot;");
  expect(xml).not.toContain("<password>");
  expect(xml).toContain("<startmode>Manual</startmode>");
});

test("new keys stage only encrypted PKCS8 and can be reloaded through KeePassXC", async () => {
  if (!available("keepassxc-cli")) return;
  const { s, path } = await fixture("Keys");
  const pass = "synthetic-new-key";
  await s.hub.vault.unlock(pass, true);
  const inv = await (await import("../src/inventory")).loadInventory(path);
  const created = await createKey("example", inv, path, async () => pass);
  expect(created.reused).toBe(false);
  const stored = await (await import("../src/session")).databaseCommand(
    s.hub.vault.path,
    pass,
    ["attachment-export", "--stdout", "homectl-example", "id_ed25519"],
  );
  expect(stored.toString()).toContain("BEGIN ENCRYPTED PRIVATE KEY");
  const next = await createKey("example", inv, path, async () => pass);
  expect(next.reused).toBe(true);
  expect(next.auth.public_key).toBe(created.auth.public_key);
}, 30_000);

test("simultaneous peer sync does not deadlock and offers require a local review", async () => {
  const first = await fixture("Linux"),
    second = await fixture("Windows");
  await first.s.hub.openPair();
  await second.s.hub.join(first.s.address, first.s.hub.pair?.code ?? "");
  await first.s.hub.confirm(defaults());
  await second.s.hub.confirm(defaults());
  await second.s.hub.pollPair();
  const previews = await Promise.all([
    first.s.hub.beginSync(second.s.hub.state.id),
    second.s.hub.beginSync(first.s.hub.state.id),
  ]);
  expect(previews).toHaveLength(2);
  const done = await first.s.hub.syncCommit(previews[0]?.id ?? "", {});
  expect(done.applied).toBe(true);
  expect(second.s.hub.pending.size).toBeGreaterThan(0);
}, 30_000);
test("remote mutations wait for local approval and are cancelled by revoked grants", async () => {
  const { s, path } = await fixture("Executor");
  await saveInventory(path, {
    version: 1,
    machines: {
      local: {
        description: "Synthetic local",
        transport: "local",
        access: "full",
      },
    },
  });
  const peer = {
    id: b,
    name: "Requester",
    platform: "linux",
    address: "http://127.0.0.1:1234",
    key: "00".repeat(32),
    permissions: {
      sync: true,
      diagnostics: false,
      operations: ["local"],
      administer: true,
    },
    pairedAt: Date.now(),
  };
  s.hub.state.peers[b] = peer;
  const request = (await s.hub.remoteAction(peer, "exec", {
    host: "local",
    argv: ["touch", join(dirnameFor(path), "must-not-exist")],
    impact: "Create only a synthetic fixture file",
  })) as { pending: boolean; id: string };
  expect(request.pending).toBe(true);
  expect(
    await Bun.file(join(dirnameFor(path), "must-not-exist")).exists(),
  ).toBe(false);
  await s.hub.permissions(b, {
    sync: true,
    diagnostics: false,
    operations: [],
    administer: false,
  });
  await expect(s.hub.decideOperation(request.id, true)).rejects.toThrow(
    "grant changed",
  );
  expect(
    await Bun.file(join(dirnameFor(path), "must-not-exist")).exists(),
  ).toBe(false);
});
function dirnameFor(path: string) {
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
}

test("locking discards secret-bearing previews and credential payload references", async () => {
  const { s } = await fixture("Lock");
  s.hub.state.records["credential:homectl-example"] = {
    clock: { [s.hub.state.id]: 1 },
    value: {
      title: "homectl-example",
      fields: { Password: "synthetic-secret-only" },
      attachments: {},
    },
  };
  await s.hub.lock();
  expect(JSON.stringify(s.hub.state.records)).not.toContain(
    "synthetic-secret-only",
  );
  expect(s.hub.pending.size).toBe(0);
});
