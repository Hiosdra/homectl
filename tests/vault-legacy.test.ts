import { afterAll, expect, test } from "bun:test";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomectlError } from "../src/types";
import {
  createDatabase,
  inspectLegacy,
  openDatabase,
  passwordSource,
  VaultSession,
} from "../src/vault";

// Builds a database the way 0.2 did: entries titled "homectl-<name>" at the
// root, the SSH key as the id_ed25519 attachment, and the key's passphrase in
// the Password field (as keys.ts writes it through keepassxc-cli).
const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = "legacy-database-password";
const PASSPHRASE = "legacy-key-passphrase-93ab";
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function codeOf(work: () => unknown): Promise<number | undefined> {
  try {
    await work();
  } catch (error) {
    return error instanceof HomectlError ? error.code : -1;
  }
  return undefined;
}

function sshBlob(raw: Buffer): string {
  const name = Buffer.from("ssh-ed25519");
  const length = (n: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n);
    return bytes;
  };
  return Buffer.concat([
    length(name.length),
    name,
    length(raw.length),
    raw,
  ]).toString("base64");
}

async function legacyFixture() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-vault-legacy-"));
  dirs.push(dir);
  const path = join(dir, "homelab.kdbx");
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase: PASSPHRASE,
  });
  const database = await createDatabase(path, passwordSource(PASSWORD), {
    argon2: SMALL,
  });
  const root = database.db.getDefaultGroup();
  const key = database.db.createEntry(root);
  key.fields.set("Title", "homectl-deploy");
  key.fields.set("Password", PASSPHRASE);
  key.binaries.set(
    "id_ed25519",
    await database.db.createBinary(Uint8Array.from(Buffer.from(pem)).buffer),
  );
  const broken = database.db.createEntry(root);
  broken.fields.set("Title", "homectl-broken");
  broken.fields.set("Password", "wrong passphrase");
  broken.binaries.set(
    "id_ed25519",
    await database.db.createBinary(Uint8Array.from(Buffer.from(pem)).buffer),
  );
  await database.save();
  const rawPublic = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  return { dir, path, pair, rawPublic };
}

test("a 0.2-layout database opens and lists its SSH keys", async () => {
  const { path, rawPublic, pair } = await legacyFixture();
  const session = new VaultSession({
    now: () => 1_000_000,
    absoluteTtlMs: 600_000,
    idleTtlMs: 600_000,
    privilegedTtlMs: 60_000,
  });
  await session.unlock(path, passwordSource(PASSWORD));
  const listed = session.listEntries();
  expect(listed.find((entry) => entry.name === "homectl-deploy")).toMatchObject(
    {
      group: "",
      kind: "ssh-key",
      admin: false,
    },
  );
  const key = session.getSshKey("homectl-deploy");
  expect(key.publicKey).toBe(`ssh-ed25519 ${sshBlob(Buffer.from(rawPublic))}`);
  const pem = Buffer.from(key.privateKey).toString();
  expect(pem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
  expect(pem).not.toContain("ENCRYPTED");
  const parsed = createPrivateKey({ key: pem, format: "pem" });
  expect(
    createPublicKey(parsed).export({ format: "der", type: "spki" }),
  ).toEqual(pair.publicKey.export({ format: "der", type: "spki" }));
  expect(parsed.asymmetricKeyType).toBe("ed25519");
  session.lock();
}, 120_000);

test("inspectLegacy reports keys and problems without values", async () => {
  const { path } = await legacyFixture();
  const report = await inspectLegacy(path, passwordSource(PASSWORD));
  expect(report.opens).toBe(true);
  expect(report.sshKeys).toEqual(["homectl-deploy"]);
  expect(report.problems).toEqual([
    "SSH key cannot be decoded: homectl-broken",
  ]);
  expect(JSON.stringify(report)).not.toContain(PASSPHRASE);
}, 120_000);

test("inspectLegacy reports a wrong password without details", async () => {
  const { path } = await legacyFixture();
  const report = await inspectLegacy(path, passwordSource("not the password"));
  expect(report).toEqual({
    opens: false,
    sshKeys: [],
    problems: ["Database could not be opened with the given password"],
  });
}, 120_000);

test("duplicate legacy names are refused rather than guessed at", async () => {
  const { path } = await legacyFixture();
  const session = new VaultSession({
    now: () => 1_000_000,
    absoluteTtlMs: 600_000,
    idleTtlMs: 600_000,
    privilegedTtlMs: 60_000,
  });
  await session.unlock(path, passwordSource(PASSWORD));
  session.lock();
  // Adding a duplicate needs the raw file, which is what a KeePassXC user does.
  const raw = await openDatabase(path, passwordSource(PASSWORD));
  const copy = raw.db.createEntry(raw.db.getDefaultGroup());
  copy.fields.set("Title", "homectl-deploy");
  await raw.save();
  const report = await inspectLegacy(path, passwordSource(PASSWORD));
  expect(report.problems).toContain("Duplicate entry name: homectl-deploy");
  await session.unlock(path, passwordSource(PASSWORD));
  expect(await codeOf(() => session.getSshKey("homectl-deploy"))).toBe(2);
  session.lock();
}, 120_000);
