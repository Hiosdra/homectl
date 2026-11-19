import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomectlError } from "../src/types";
import {
  ADMIN_TAG,
  createDatabase,
  exportTo,
  importFrom,
  passwordSource,
  VaultSession,
} from "../src/vault";

const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = "transfer-source-password";
const EXPORT_PASSWORD = "transfer-export-password";
const SECRET = "round-trip-secret-88aa";
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

// A fresh vault with an unlocked, freshly elevated session.
async function vaultWithEntries(
  dir: string,
  name: string,
): Promise<{ path: string; session: VaultSession }> {
  const path = join(dir, `${name}.kdbx`);
  await createDatabase(path, passwordSource(PASSWORD), { argon2: SMALL });
  let now = 1_000_000;
  const session = new VaultSession({
    now: () => now,
    absoluteTtlMs: 600_000,
    idleTtlMs: 600_000,
    privilegedTtlMs: 60_000,
  });
  await session.unlock(path, passwordSource(PASSWORD));
  now += 1;
  await session.elevate(passwordSource(PASSWORD));
  return { path, session };
}

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-vault-transfer-"));
  dirs.push(dir);
  return dir;
}

test("export needs a privileged session and refuses to overwrite", async () => {
  const dir = await workdir();
  const source = await vaultWithEntries(dir, "source");
  await source.session.putSecret(
    "svc-a",
    { Password: SECRET },
    { tags: ["lab"] },
  );
  source.session.lock();
  await source.session.unlock(source.path, passwordSource(PASSWORD));
  const out = join(dir, "export.kdbx");
  expect(
    await codeOf(() =>
      exportTo(
        out,
        passwordSource(EXPORT_PASSWORD),
        ["svc-a"],
        source.session,
        {
          argon2: SMALL,
        },
      ),
    ),
  ).toBe(5);
  await expect(stat(out)).rejects.toThrow();

  await source.session.elevate(passwordSource(PASSWORD));
  await exportTo(
    out,
    passwordSource(EXPORT_PASSWORD),
    ["svc-a"],
    source.session,
    {
      argon2: SMALL,
    },
  );
  const before = await readFile(out);
  expect(
    await codeOf(() =>
      exportTo(
        out,
        passwordSource(EXPORT_PASSWORD),
        ["svc-a"],
        source.session,
        {
          argon2: SMALL,
        },
      ),
    ),
  ).toBe(3);
  expect(await readFile(out)).toEqual(before);
  source.session.lock();
}, 120_000);

test("export then import round-trips values and tags", async () => {
  const dir = await workdir();
  const source = await vaultWithEntries(dir, "source");
  await source.session.putSecret(
    "svc-a",
    { Password: SECRET, UserName: "ops" },
    {
      tags: ["lab"],
    },
  );
  const out = join(dir, "export.kdbx");
  await exportTo(
    out,
    passwordSource(EXPORT_PASSWORD),
    ["svc-a"],
    source.session,
    {
      argon2: SMALL,
    },
  );
  source.session.lock();

  const target = await vaultWithEntries(dir, "target");
  const result = await importFrom(
    out,
    passwordSource(EXPORT_PASSWORD),
    ["svc-a"],
    target.session,
  );
  expect(result.names).toEqual(["svc-a"]);
  const listed = target.session.listEntries();
  expect(listed.map((entry) => [entry.name, entry.tags])).toEqual([
    ["svc-a", ["lab"]],
  ]);
  expect(target.session.getSecret(listed[0]?.id ?? "")).toEqual({
    Password: SECRET,
    UserName: "ops",
  });

  // Importing the same name again is refused, not merged.
  expect(
    await codeOf(() =>
      importFrom(
        out,
        passwordSource(EXPORT_PASSWORD),
        ["svc-a"],
        target.session,
      ),
    ),
  ).toBe(3);
  target.session.lock();
}, 120_000);

test("importing an admin entry needs privilege", async () => {
  const dir = await workdir();
  const source = await vaultWithEntries(dir, "source");
  await source.session.putSecret(
    "svc-admin",
    { Password: SECRET },
    {
      tags: [ADMIN_TAG],
    },
  );
  const out = join(dir, "admin.kdbx");
  await exportTo(
    out,
    passwordSource(EXPORT_PASSWORD),
    ["svc-admin"],
    source.session,
    {
      argon2: SMALL,
    },
  );
  source.session.lock();

  const target = await vaultWithEntries(dir, "target");
  target.session.lock();
  await target.session.unlock(target.path, passwordSource(PASSWORD));
  expect(
    await codeOf(() =>
      importFrom(
        out,
        passwordSource(EXPORT_PASSWORD),
        ["svc-admin"],
        target.session,
      ),
    ),
  ).toBe(5);
  expect(target.session.listEntries()).toEqual([]);
  target.session.lock();
}, 120_000);

test("imports from a KeePassXC-style file without modifying it", async () => {
  const dir = await workdir();
  const external = join(dir, "external.kdbx");
  const built = await createDatabase(external, passwordSource("external-pw"), {
    argon2: SMALL,
  });
  const email = built.db.createEntry(built.db.getDefaultGroup());
  email.fields.set("Title", "Email");
  email.fields.set("UserName", "someone");
  email.fields.set("Password", "external-value");
  await built.save();
  const before = await readFile(external);

  const target = await vaultWithEntries(dir, "target");
  await importFrom(
    external,
    passwordSource("external-pw"),
    ["Email"],
    target.session,
  );
  expect(await readFile(external)).toEqual(before);
  const listed = target.session.listEntries();
  expect(listed.map((entry) => [entry.name, entry.group, entry.kind])).toEqual([
    ["Email", "homectl/secrets", "secret"],
  ]);
  expect(JSON.stringify(listed)).not.toContain("external-value");
  target.session.lock();
}, 120_000);
