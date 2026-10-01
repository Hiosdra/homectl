import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSpec } from "../src/credentials";
import { loadInventory, saveInventory } from "../src/inventory";
import { workerPath } from "../src/operations";
import { run } from "../src/process";
import {
  databaseCommand,
  loadKey,
  lockSession,
  privateCommand,
  readPassword,
  sessionConfig,
  sessionPaths,
  sessionStatus,
  startSession,
  ttlSeconds,
  unlockSession,
} from "../src/session";
import { keyReference } from "../src/session/keys";
import { normalizePublicKey } from "../src/session/public-key";
import type { Inventory } from "../src/types";

// Synthetic credentials only. All databases, keys and sockets belong to this
// suite's temporary directories; the user's database/SSH agent is never used.
const password = "homectl-test-database-only";
let root: string;
let seed: string;
let privateKey: string;
const sessions: string[] = [];

beforeAll(async () => {
  for (const tool of ["ssh-agent", "ssh-add", "ssh-keygen", "keepassxc-cli"])
    if (!Bun.which(tool))
      throw new Error(`Session integration tests require ${tool}`);
  root = await mkdtemp(join(tmpdir(), "hcts-"));
  seed = join(root, "seed.kdbx");
  privateKey = join(root, "fixture-key");
  await privateCommand([
    "ssh-keygen",
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    privateKey,
  ]);
  await privateCommand(
    [
      "keepassxc-cli",
      "db-create",
      "--quiet",
      "--set-password",
      "--decryption-time",
      "100",
      seed,
    ],
    `${password}\n${password}\n`,
  );
  await databaseCommand(seed, password, ["add", "homectl-example"]);
  await databaseCommand(seed, password, [
    "attachment-import",
    "homectl-example",
    "id_ed25519",
    privateKey,
  ]);
  await databaseCommand(seed, password, ["add", "homectl-incomplete"]);
}, 30_000);

afterEach(async () => {
  for (const path of sessions.splice(0)) await lockSession(path);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(ttl = "24h") {
  const dir = await mkdtemp(join(root, "case-"));
  const path = join(dir, "i.yaml");
  sessions.push(path);
  const database = join(dir, "homelab.kdbx");
  await copyFile(seed, database);
  const auth = keyReference("example", path);
  await mkdir(sessionPaths(path).keys, { mode: 0o700 });
  await copyFile(`${privateKey}.pub`, auth.public_key);
  const inv: Inventory = {
    version: 1,
    session: { ttl, database },
    machines: {
      example: {
        description: "Synthetic SSH fixture",
        transport: "ssh",
        access: "user",
        address: "192.0.2.1",
        user: "operator",
        ssh_alias: "example",
        auth,
      },
    },
  };
  await saveInventory(path, inv);
  return { path, inv, auth };
}
async function canSign(path: string, publicKey: string) {
  await privateCommand(["ssh-add", "-T", publicKey], undefined, {
    SSH_AUTH_SOCK: sessionPaths(path).socket,
  });
}
async function untilLocked(path: string, deadline: number) {
  while (Date.now() < deadline) {
    if (!(await sessionStatus(path)).unlocked) return;
    await Bun.sleep(30);
  }
  throw new Error("Session did not expire before deadline");
}

test("TTL accepts bounded durations and rejects malformed/out-of-range values", () => {
  for (const [ttl, seconds] of [
    ["1s", 1],
    ["2m", 120],
    ["24h", 86400],
    ["365d", 31536000],
  ] as const)
    expect(ttlSeconds(ttl)).toBe(seconds);
  expect(ttlSeconds("until-reboot")).toBeNull();
  for (const ttl of ["0s", "366d", "-1h", "1.5h", "24", "forever", " 1h"])
    expect(() => ttlSeconds(ttl)).toThrow();
});
test("default session configuration uses a local database and 24h TTL", () => {
  expect(
    sessionConfig({ version: 1, machines: {} }, "/tmp/example/i.yaml"),
  ).toEqual({ ttl: "24h", database: "/tmp/example/homelab.kdbx" });
});
test("missing runtime sockets report locked", async () => {
  const { path } = await fixture();
  expect(await sessionStatus(path)).toEqual({ unlocked: false });
});
test("real KDBX unlock loads a signing key; repeat unlock preserves expiry without a password", async () => {
  const { path, inv, auth } = await fixture();
  let prompts = 0;
  const prompt = async () => {
    prompts++;
    return password;
  };
  const first = await unlockSession(inv, path, prompt);
  expect(first.unlocked).toBe(true);
  expect("keysLoaded" in first ? first.keysLoaded : undefined).toBe(1);
  expect(first.expiresAt).toBe((first.startedAt ?? 0) + 86400_000);
  await canSign(path, auth.public_key);
  const again = await unlockSession(inv, path, prompt);
  expect(prompts).toBe(1);
  expect(again.startedAt).toBe(first.startedAt);
  expect(again.expiresAt).toBe(first.expiresAt);
  expect((await lstat(sessionPaths(path).directory)).mode & 0o777).toBe(0o700);
});
test("lock clears authentication; a fresh unlock creates a new session and reloads keys", async () => {
  const { path, inv, auth } = await fixture();
  const first = await unlockSession(inv, path, async () => password);
  await lockSession(path);
  expect(await sessionStatus(path)).toEqual({ unlocked: false });
  await expect(canSign(path, auth.public_key)).rejects.toMatchObject({
    code: 5,
  });
  const next = await unlockSession(inv, path, async () => password);
  expect(next.startedAt).toBeGreaterThan(first.startedAt ?? 0);
  await canSign(path, auth.public_key);
});
test("timed session expires and removes access to loaded keys", async () => {
  const { path, inv, auth } = await fixture("2s");
  const state = await unlockSession(inv, path, async () => password);
  await canSign(path, auth.public_key);
  await untilLocked(path, (state.expiresAt ?? 0) + 3000);
  await expect(canSign(path, auth.public_key)).rejects.toMatchObject({
    code: 5,
  });
}, 10_000);
test("until-reboot has no scheduled expiry and still supports explicit lock", async () => {
  const { path, inv, auth } = await fixture("until-reboot");
  const state = await unlockSession(inv, path, async () => password);
  expect(state.expiresAt).toBeNull();
  await canSign(path, auth.public_key);
  await lockSession(path);
  expect((await sessionStatus(path)).unlocked).toBe(false);
});
test("locking one inventory leaves another agent's loaded keys untouched", async () => {
  const first = await fixture();
  const other = await fixture();
  await unlockSession(first.inv, first.path, async () => password);
  await unlockSession(other.inv, other.path, async () => password);
  await lockSession(first.path);
  expect((await sessionStatus(other.path)).unlocked).toBe(true);
  await canSign(other.path, other.auth.public_key);
});
test("wrong database password fails without diagnostic leaks and leaves the session locked", async () => {
  const { path, inv } = await fixture();
  const wrong = "synthetic-wrong-password";
  try {
    await unlockSession(inv, path, async () => wrong);
    throw new Error("Unlock unexpectedly succeeded");
  } catch (error) {
    expect(error).toMatchObject({ code: 5 });
    expect(String(error)).not.toContain(wrong);
    expect(String(error)).not.toContain(password);
    expect(String(error)).not.toContain("BEGIN OPENSSH");
  }
  expect((await sessionStatus(path)).unlocked).toBe(false);
});
test("a missing attachment locks even keys loaded earlier in a partial unlock", async () => {
  const { path, inv, auth } = await fixture();
  const example = inv.machines.example;
  if (!example) throw new Error("Missing fixture machine");
  inv.machines.incomplete = {
    ...example,
    ssh_alias: "incomplete",
    auth: keyReference("incomplete", path),
  };
  await expect(
    unlockSession(inv, path, async () => password),
  ).rejects.toMatchObject({ code: 5 });
  expect((await sessionStatus(path)).unlocked).toBe(false);
  await expect(canSign(path, auth.public_key)).rejects.toMatchObject({
    code: 5,
  });
});
test("missing database fails before prompting or starting a session", async () => {
  const { path, inv } = await fixture();
  if (!inv.session) throw new Error("Missing fixture session");
  inv.session.database = join(root, "missing.kdbx");
  let prompted = false;
  await expect(
    unlockSession(inv, path, async () => {
      prompted = true;
      return password;
    }),
  ).rejects.toMatchObject({ code: 5 });
  expect(prompted).toBe(false);
  expect((await sessionStatus(path)).unlocked).toBe(false);
});
test("socket mismatch fails and cleans up the newly started session", async () => {
  const { path, inv, auth } = await fixture();
  auth.socket = join(root, "other.session/agent.sock");
  await expect(
    unlockSession(inv, path, async () => password),
  ).rejects.toMatchObject({ code: 2 });
  expect((await sessionStatus(path)).unlocked).toBe(false);
});
test("expired keys cannot be loaded", async () => {
  const { path } = await fixture();
  await expect(
    loadKey(new Uint8Array(), path, {
      unlocked: true,
      expiresAt: Date.now() - 1,
    }),
  ).rejects.toMatchObject({ code: 5 });
});
test("session startup refuses a symlinked runtime directory or conflicting socket file", async () => {
  const f = await fixture();
  const target = join(root, "symlink-target");
  await mkdir(target);
  await symlink(target, sessionPaths(f.path).directory);
  await expect(startSession(f.inv, f.path)).rejects.toMatchObject({ code: 3 });
  await rm(sessionPaths(f.path).directory);
  await mkdir(sessionPaths(f.path).directory);
  await writeFile(sessionPaths(f.path).socket, "user-owned placeholder");
  await expect(startSession(f.inv, f.path)).rejects.toMatchObject({ code: 3 });
  expect(await readFile(sessionPaths(f.path).socket, "utf8")).toBe(
    "user-owned placeholder",
  );
});
test("public key normalization accepts comments but rejects malformed wire data", async () => {
  const pub = await readFile(`${privateKey}.pub`, "utf8");
  expect(normalizePublicKey(`${pub.trim()} fixture-comment`)).toBe(
    normalizePublicKey(pub),
  );
  for (const value of [
    "ssh-ed25519 AAAA",
    "ssh-rsa AAAA",
    `${pub}\0`,
    "not a key",
  ])
    expect(() => normalizePublicKey(value)).toThrow();
});
test("managed worker rejects a locked session before launching SSH", async () => {
  const { path, auth } = await fixture();
  const result = await run(
    credentialSpec(
      auth,
      { argv: ["ssh", "192.0.2.1"], timeoutMs: 1000 },
      workerPath,
    ),
  );
  expect(result.exitCode).toBe(5);
  expect(result.stderr).toContain("session is locked");
  expect((await sessionStatus(path)).unlocked).toBe(false);
});
test("password prompt refuses noninteractive execution", async () => {
  if (!process.stdin.isTTY)
    await expect(readPassword()).rejects.toMatchObject({ code: 5 });
});

test("CLI TTL configuration locks the session and the next unlock uses the new lifetime", async () => {
  const { path, inv, auth } = await fixture();
  await unlockSession(inv, path, async () => password);
  const result = await run({
    argv: [
      process.execPath,
      join(import.meta.dir, "../src/cli/main.ts"),
      "session",
      "configure",
      "--inventory",
      path,
      "--ttl",
      "12h",
      "--json",
    ],
  });
  expect(result.exitCode).toBe(0);
  expect((await sessionStatus(path)).unlocked).toBe(false);
  const updated = await loadInventory(path);
  expect(updated.session?.ttl).toBe("12h");
  expect(updated.session?.database).toBe(inv.session?.database);
  const state = await unlockSession(updated, path, async () => password);
  expect(state.expiresAt).toBe((state.startedAt ?? 0) + 43200_000);
  await canSign(path, auth.public_key);
});
