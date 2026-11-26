import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windows } from "../src/platform";
import { HomectlError } from "../src/types";
import { createDatabase, openDatabase, passwordSource } from "../src/vault";

const SMALL = { memory: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = "correct horse battery staple";
const dirs: string[] = [];

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "homectl-vault-kdbx-"));
  dirs.push(dir);
  return dir;
}

async function codeOf(
  work: () => Promise<unknown>,
): Promise<number | undefined> {
  try {
    await work();
  } catch (error) {
    return error instanceof HomectlError ? error.code : -1;
  }
  return undefined;
}

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("creates a database that opens with the password and rejects a wrong one", async () => {
  const path = join(await workdir(), "vault.kdbx");
  await createDatabase(path, passwordSource(PASSWORD), { argon2: SMALL });
  const opened = await openDatabase(path, passwordSource(PASSWORD));
  expect(opened.path).toBe(path);
  expect(opened.db.getDefaultGroup().groups.map((g) => g.name)).toContain(
    "homectl",
  );
  let message = "";
  try {
    await openDatabase(path, passwordSource("wrong password 123"));
  } catch (error) {
    expect(error).toBeInstanceOf(HomectlError);
    message = (error as HomectlError).message;
  }
  expect(message).toContain("unlock failed");
  expect(message).not.toContain("wrong password");
}, 60_000);

test("refuses to overwrite an existing database and leaves it unchanged", async () => {
  const path = join(await workdir(), "vault.kdbx");
  await createDatabase(path, passwordSource(PASSWORD), { argon2: SMALL });
  const before = await readFile(path);
  expect(
    await codeOf(() =>
      createDatabase(path, passwordSource("another password"), {
        argon2: SMALL,
      }),
    ),
  ).toBe(3);
  expect(await readFile(path)).toEqual(before);
}, 60_000);

test("saves atomically with no temp files left behind", async () => {
  const dir = await workdir();
  const path = join(dir, "vault.kdbx");
  const database = await createDatabase(path, passwordSource(PASSWORD), {
    argon2: SMALL,
  });
  database.db
    .createEntry(database.db.getDefaultGroup())
    .fields.set("Title", "homectl-x");
  await database.save();
  const files = await readdir(dir);
  expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(files).toEqual(["vault.kdbx"]);
  if (!windows) expect((await stat(path)).mode & 0o777).toBe(0o600);
}, 60_000);

test("refuses unsafe Argon2 parameters", async () => {
  const path = join(await workdir(), "vault.kdbx");
  expect(
    await codeOf(() =>
      createDatabase(path, passwordSource(PASSWORD), {
        argon2: { memory: 4, iterations: 1, parallelism: 1 },
      }),
    ),
  ).toBe(2);
  expect(await codeOf(() => openDatabase(path, passwordSource(PASSWORD)))).toBe(
    5,
  );
  await writeFile(path, "not a database");
  expect(await codeOf(() => openDatabase(path, passwordSource(PASSWORD)))).toBe(
    5,
  );
}, 60_000);
