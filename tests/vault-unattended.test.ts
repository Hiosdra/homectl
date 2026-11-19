import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windows } from "../src/platform";
import { HomectlError } from "../src/types";
import {
  ADMIN_TAG,
  createDatabase,
  createUnattended,
  openDatabase,
  openUnattended,
  passwordSource,
  unattendedKeySource,
  VaultSession,
} from "../src/vault";
import type { LockReason } from "../src/vault/types";

const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = "unattended-test-password";
const SECRET_A = "unattended-secret-A-41c0";
const SECRET_ADMIN = "admin-secret-never-copied-7d2e";
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

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-vault-unattended-"));
  dirs.push(dir);
  const path = join(dir, "vault.kdbx");
  await createDatabase(path, passwordSource(PASSWORD), { argon2: SMALL });
  const now = 1_000_000;
  const session = new VaultSession({
    now: () => now,
    absoluteTtlMs: 600_000,
    idleTtlMs: 600_000,
    privilegedTtlMs: 60_000,
  });
  await session.unlock(path, passwordSource(PASSWORD));
  await session.elevate(passwordSource(PASSWORD));
  await session.putSecret("svc-a", { Password: SECRET_A });
  await session.putSecret(
    "svc-admin",
    { Password: SECRET_ADMIN },
    { tags: [ADMIN_TAG] },
  );
  return { dir, path, session, dirOf: (name: string) => join(dir, name) };
}

test("refuses admin entries and writes nothing", async () => {
  const { session, dirOf } = await fixture();
  const keyFile = dirOf("unattended.key");
  expect(
    await codeOf(() =>
      createUnattended(
        {
          path: dirOf("unattended.kdbx"),
          keyFile,
          entries: ["svc-a", "svc-admin"],
          argon2: SMALL,
        },
        session,
      ),
    ),
  ).toBe(2);
  await expect(stat(keyFile)).rejects.toThrow();
  await expect(stat(dirOf("unattended.kdbx"))).rejects.toThrow();
  session.lock();
}, 120_000);

test("copies only non-admin entries, with a 32-byte 0600 key file", async () => {
  const { session, dirOf } = await fixture();
  const keyFile = dirOf("unattended.key");
  const result = await createUnattended(
    {
      path: dirOf("unattended.kdbx"),
      keyFile,
      entries: ["svc-a"],
      argon2: SMALL,
    },
    session,
  );
  expect(result.entries).toEqual(["svc-a"]);
  expect((await stat(keyFile)).size).toBe(32);
  if (!windows) expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  const restricted = await openUnattended(dirOf("unattended.kdbx"), keyFile);
  const listed = restricted.listEntries();
  expect(listed.map((entry) => entry.name)).toEqual(["svc-a"]);
  expect(JSON.stringify(listed)).not.toContain(SECRET_A);
  expect(restricted.getSecret(listed[0]?.id ?? "")).toEqual({
    Password: SECRET_A,
  });
  session.lock();
  restricted.lock();
}, 120_000);

test("restricted session cannot elevate or write and is locked by lock()", async () => {
  const { session, dirOf } = await fixture();
  const keyFile = dirOf("unattended.key");
  await createUnattended(
    {
      path: dirOf("unattended.kdbx"),
      keyFile,
      entries: ["svc-a"],
      argon2: SMALL,
    },
    session,
  );
  const restricted = await openUnattended(dirOf("unattended.kdbx"), keyFile);
  expect(await codeOf(() => restricted.elevate())).toBe(5);
  expect(await codeOf(() => restricted.putSecret())).toBe(5);
  expect(await codeOf(() => restricted.removeEntry())).toBe(5);
  expect(await codeOf(() => restricted.setTags())).toBe(5);
  const reasons: LockReason[] = [];
  restricted.onLock((reason) => reasons.push(reason));
  restricted.lock();
  restricted.lock();
  expect(reasons).toEqual(["manual"]);
  expect(restricted.state().unlocked).toBe(false);
  expect(await codeOf(() => restricted.listEntries())).toBe(5);
  session.lock();
}, 120_000);

test("an admin tag added to a copy later is not returned after restart", async () => {
  const { session, dirOf } = await fixture();
  const keyFile = dirOf("unattended.key");
  const unattendedPath = dirOf("unattended.kdbx");
  await createUnattended(
    { path: unattendedPath, keyFile, entries: ["svc-a"], argon2: SMALL },
    session,
  );
  const before = await openUnattended(unattendedPath, keyFile);
  const id = before.listEntries()[0]?.id ?? "";
  before.lock();

  // Someone with the key file re-tags the copy as admin.
  const editable = await openDatabase(
    unattendedPath,
    unattendedKeySource(keyFile),
  );
  const entry = editable.db.groups
    .flatMap((group) => [...group.allEntries()])
    .find((candidate) => candidate.fields.get("Title") === "svc-a");
  expect(entry).toBeDefined();
  entry?.tags.push(ADMIN_TAG);
  entry?.times.update();
  await editable.save();

  const after = await openUnattended(unattendedPath, keyFile);
  expect(after.listEntries()).toEqual([]);
  expect(await codeOf(() => after.getSecret(id))).toBe(2);
  expect(await codeOf(() => after.getSshKey("svc-a"))).toBe(2);
  after.lock();
  session.lock();
}, 120_000);

test("refuses to overwrite an existing key file or database", async () => {
  const { session, dirOf } = await fixture();
  const keyFile = dirOf("unattended.key");
  await writeFile(keyFile, "previous key material");
  expect(
    await codeOf(() =>
      createUnattended(
        { path: dirOf("a.kdbx"), keyFile, entries: ["svc-a"], argon2: SMALL },
        session,
      ),
    ),
  ).toBe(3);
  await expect(stat(dirOf("a.kdbx"))).rejects.toThrow();

  // A pre-existing database is refused, and the new key file is removed again.
  const freshKey = dirOf("fresh.key");
  await writeFile(dirOf("taken.kdbx"), "existing database");
  expect(
    await codeOf(() =>
      createUnattended(
        {
          path: dirOf("taken.kdbx"),
          keyFile: freshKey,
          entries: ["svc-a"],
          argon2: SMALL,
        },
        session,
      ),
    ),
  ).toBe(3);
  await expect(stat(freshKey)).rejects.toThrow();
  session.lock();
}, 120_000);

test("wrong key file, empty selection and locked session are refused", async () => {
  const { session, dirOf } = await fixture();
  const keyFile = dirOf("unattended.key");
  await createUnattended(
    {
      path: dirOf("unattended.kdbx"),
      keyFile,
      entries: ["svc-a"],
      argon2: SMALL,
    },
    session,
  );
  const otherKey = dirOf("other.key");
  await writeFile(otherKey, Buffer.alloc(32, 7));
  expect(
    await codeOf(() => openUnattended(dirOf("unattended.kdbx"), otherKey)),
  ).toBe(5);
  expect(
    await codeOf(() =>
      createUnattended(
        {
          path: dirOf("empty.kdbx"),
          keyFile: dirOf("empty.key"),
          entries: [],
          argon2: SMALL,
        },
        session,
      ),
    ),
  ).toBe(2);
  session.lock();
  expect(
    await codeOf(() =>
      createUnattended(
        {
          path: dirOf("locked.kdbx"),
          keyFile: dirOf("locked.key"),
          entries: ["svc-a"],
          argon2: SMALL,
        },
        session,
      ),
    ),
  ).toBe(5);
}, 120_000);
