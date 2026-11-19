import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomectlError } from "../src/types";
import {
  ADMIN_TAG,
  createDatabase,
  passwordSource,
  VaultSession,
} from "../src/vault";
import type { LockReason } from "../src/vault/types";

const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = "session-test-password";
const SECRET = "value-that-must-never-leak-9f3a";
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-vault-session-"));
  dirs.push(dir);
  const path = join(dir, "vault.kdbx");
  await createDatabase(path, passwordSource(PASSWORD), { argon2: SMALL });
  return path;
}

function clockFrom(start: number) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function session(clock: { now: () => number }) {
  return new VaultSession({
    now: clock.now,
    absoluteTtlMs: 10_000,
    idleTtlMs: 3_000,
    privilegedTtlMs: 1_000,
  });
}

async function codeOf(work: () => unknown): Promise<number | undefined> {
  try {
    await work();
  } catch (error) {
    return error instanceof HomectlError ? error.code : -1;
  }
  return undefined;
}

test("metadata lists entries without any values", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  await vault.unlock(path, passwordSource(PASSWORD));
  const meta = await vault.putSecret(
    "pve-main",
    {
      UserName: "root@pam!lab",
      Password: SECRET,
    },
    { tags: ["lab"] },
  );
  expect(Object.keys(meta).sort()).toEqual(
    ["admin", "group", "id", "kind", "name", "tags", "updatedAt"].sort(),
  );
  const listed = vault.listEntries();
  expect(JSON.stringify(listed)).not.toContain(SECRET);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.name).toBe("pve-main");
  expect(listed[0]?.group).toBe("homectl/secrets");
  expect(listed[0]?.admin).toBe(false);
  // Ids are canonical UUIDs and round-trip through getSecret.
  expect(listed[0]?.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(vault.getSecret(listed[0]?.id ?? "")).toMatchObject({
    UserName: "root@pam!lab",
    Password: SECRET,
  });
  vault.lock();
}, 60_000);

test("absolute TTL locks the session even while it is being used", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  const reasons: LockReason[] = [];
  vault.onLock((reason) => reasons.push(reason));
  await vault.unlock(path, passwordSource(PASSWORD));
  for (let i = 0; i < 4; i++) {
    clock.advance(2_000);
    vault.touch();
  }
  expect(vault.state().unlocked).toBe(true);
  clock.advance(2_000);
  expect(vault.state()).toEqual({
    unlocked: false,
    expiresAt: null,
    idleExpiresAt: null,
  });
  expect(reasons).toEqual(["absolute"]);
  expect(await codeOf(() => vault.listEntries())).toBe(5);
}, 60_000);

test("state and polling never extend the idle timeout; touch does", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  const reasons: LockReason[] = [];
  vault.onLock((reason) => reasons.push(reason));
  const opened = await vault.unlock(path, passwordSource(PASSWORD));
  expect(opened.idleExpiresAt).toBe(1_003_000);

  clock.advance(2_000);
  for (let i = 0; i < 5; i++) vault.state();
  expect(vault.state().idleExpiresAt).toBe(1_003_000);
  clock.advance(1_100);
  expect(vault.state().unlocked).toBe(false);
  expect(reasons).toEqual(["idle"]);

  const second = clockFrom(2_000_000);
  const active = session(second);
  await active.unlock(path, passwordSource(PASSWORD));
  second.advance(2_000);
  expect(active.touch().idleExpiresAt).toBe(2_005_000);
  second.advance(2_500);
  expect(active.state().unlocked).toBe(true);
  active.lock();
}, 60_000);

test("privileged window is shorter, bounded by absolute expiry, and gates admin entries", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  await vault.unlock(path, passwordSource(PASSWORD));
  // Creating an admin entry is itself privileged, so do it elevated, then re-unlock.
  await vault.elevate(passwordSource(PASSWORD));
  const admin = await vault.putSecret(
    "pve-root",
    { Password: SECRET },
    { tags: [ADMIN_TAG] },
  );
  expect(admin.admin).toBe(true);
  vault.lock();
  await vault.unlock(path, passwordSource(PASSWORD));
  expect(await codeOf(() => vault.getSecret(admin.id))).toBe(5);
  expect(await codeOf(() => vault.requirePrivileged())).toBe(5);

  await expect(
    vault.elevate(passwordSource("not the password")),
  ).rejects.toThrow("Vault unlock failed");
  expect(await codeOf(() => vault.requirePrivileged())).toBe(5);

  clock.advance(1_000);
  const elevated = await vault.elevate(passwordSource(PASSWORD));
  expect(elevated.privilegedUntil).toBe(1_002_000);
  expect(vault.getSecret(admin.id)).toEqual({ Password: SECRET });
  clock.advance(1_000);
  expect(vault.state().privilegedUntil).toBeUndefined();
  expect(vault.state().unlocked).toBe(true);
  expect(await codeOf(() => vault.getSecret(admin.id))).toBe(5);
  vault.lock();
}, 60_000);

test("elevation never outlives the absolute expiry", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  await vault.unlock(path, passwordSource(PASSWORD));
  // Keep the session alive past the idle window, then elevate near absolute expiry.
  for (let i = 0; i < 3; i++) {
    clock.advance(2_500);
    vault.touch();
  }
  clock.advance(2_000);
  const elevated = await vault.elevate(passwordSource(PASSWORD));
  expect(elevated.privilegedUntil).toBe(1_010_000);
  expect(elevated.expiresAt).toBe(1_010_000);
  vault.lock();
}, 60_000);

test("setting or keeping the admin tag requires privilege", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  await vault.unlock(path, passwordSource(PASSWORD));
  const entry = await vault.putSecret("svc-a", { Password: SECRET });
  expect(await codeOf(() => vault.setTags(entry.id, [ADMIN_TAG]))).toBe(5);
  await vault.elevate(passwordSource(PASSWORD));
  const tagged = await vault.setTags(entry.id, [ADMIN_TAG]);
  expect(tagged.admin).toBe(true);
  vault.lock();
}, 60_000);

test("lock notifies listeners once and every accessor throws afterwards", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  await vault.unlock(path, passwordSource(PASSWORD));
  const entry = await vault.putSecret("svc-a", { Password: SECRET });
  const reasons: LockReason[] = [];
  const stop = vault.onLock((reason) => reasons.push(reason));
  vault.lock();
  vault.lock();
  expect(reasons).toEqual(["manual"]);
  expect(await codeOf(() => vault.listEntries())).toBe(5);
  expect(await codeOf(() => vault.getSecret(entry.id))).toBe(5);
  expect(await codeOf(() => vault.getSshKey("svc-a"))).toBe(5);
  expect(await codeOf(() => vault.touch())).toBe(5);
  expect(await codeOf(() => vault.requirePrivileged())).toBe(5);
  await expect(vault.putSecret("svc-b", { Password: SECRET })).rejects.toThrow(
    "Vault is locked",
  );

  await vault.unlock(path, passwordSource(PASSWORD));
  stop();
  vault.lock();
  expect(reasons).toEqual(["manual"]);
}, 60_000);

test("a second unlock while open is refused and does not extend TTLs", async () => {
  const path = await fixture();
  const clock = clockFrom(1_000_000);
  const vault = session(clock);
  await vault.unlock(path, passwordSource(PASSWORD));
  clock.advance(2_000);
  vault.touch();
  expect(await codeOf(() => vault.unlock(path, passwordSource(PASSWORD)))).toBe(
    3,
  );
  expect(vault.state().expiresAt).toBe(1_010_000);
  vault.lock();
}, 60_000);

test("invalid TTLs are refused", () => {
  expect(
    () =>
      new VaultSession({
        now: () => 0,
        absoluteTtlMs: 0,
        idleTtlMs: 1,
        privilegedTtlMs: 1,
      }),
  ).toThrow(HomectlError);
});
