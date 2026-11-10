import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { available, windows } from "../src/platform";
import {
  databaseCommand,
  getSessionSecret,
  lockSession,
  privateCommand,
  putSessionSecret,
  readApiTokenHeader,
  sessionStatus,
} from "../src/session";
import { HomectlError } from "../src/types";

const PASSWORD = "homectl-test-database-only";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "homectl-api-token-"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

// The session agent holds the token in memory. These tests run a real daemon,
// started by a separate process, the way `session unlock` does.
describe.skipIf(windows || !available("ssh-agent"))(
  "session agent secrets",
  () => {
    test("a secret lives in the unlocked session only, and is cleared on lock", async () => {
      const dir = await mkdtemp(join(root, "agent-"));
      const inventory = join(dir, "inventory.yaml");
      const module = resolve(import.meta.dir, "../src/session/index.ts");
      const script = `const {startSession}=await import(${JSON.stringify(module)});const path=process.argv.at(-1);await startSession({version:1,machines:{}},path);process.exit(0);`;
      const starter = Bun.spawn([process.execPath, "-e", script, inventory], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await starter.exited).toBe(0);
      try {
        expect((await sessionStatus(inventory)).unlocked).toBe(true);
        const header = "PVEAPIToken=ops@pve!homectl=SECRET-VALUE-456";
        await putSessionSecret(inventory, "pve-api-pve-test", header);
        expect(await getSessionSecret(inventory, "pve-api-pve-test")).toBe(
          header,
        );
        expect(
          await getSessionSecret(inventory, "pve-api-missing"),
        ).toBeUndefined();
        // Names are validated; a hostile name is refused by the agent.
        expect(await getSessionSecret(inventory, "../escape")).toBeUndefined();

        await lockSession(inventory);
        expect(
          await getSessionSecret(inventory, "pve-api-pve-test"),
        ).toBeUndefined();
        await expect(
          putSessionSecret(inventory, "pve-api-pve-test", header),
        ).rejects.toThrow(HomectlError);
      } finally {
        await lockSession(inventory);
        await rm(dir, { recursive: true, force: true });
      }
    }, 20_000);
  },
);

describe.skipIf(!available("keepassxc-cli"))(
  "reading the API token from KDBX",
  () => {
    test("UserName is user@realm!tokenid and Password is the secret, combined into one header", async () => {
      const database = join(root, "token.kdbx");
      await privateCommand(
        [
          "keepassxc-cli",
          "db-create",
          "--quiet",
          "--set-password",
          "--decryption-time",
          "100",
          database,
        ],
        `${PASSWORD}\n${PASSWORD}\n`,
      );
      await databaseCommand(database, PASSWORD, [
        "add",
        "-g",
        "--username",
        "ops@pve!homectl",
        "homectl-pve-token",
      ]);
      const header = await readApiTokenHeader(
        database,
        PASSWORD,
        "homectl-pve-token",
      );
      expect(header).toMatch(/^PVEAPIToken=ops@pve!homectl=[^\s]+$/);
      expect(header.length).toBeGreaterThan(
        "PVEAPIToken=ops@pve!homectl=".length,
      );
    });

    test("a UserName that is not a token id is refused", async () => {
      const database = join(root, "bad-token.kdbx");
      await privateCommand(
        [
          "keepassxc-cli",
          "db-create",
          "--quiet",
          "--set-password",
          "--decryption-time",
          "100",
          database,
        ],
        `${PASSWORD}\n${PASSWORD}\n`,
      );
      await databaseCommand(database, PASSWORD, [
        "add",
        "-g",
        "--username",
        "not-a-token-id",
        "homectl-pve-token",
      ]);
      await expect(
        readApiTokenHeader(database, PASSWORD, "homectl-pve-token"),
      ).rejects.toThrow("user@realm!tokenid");
    });
  },
);
