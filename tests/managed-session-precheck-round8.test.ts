import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/operations";
import { sessionPaths } from "../src/session/config";
import type { Machine } from "../src/types";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0)) await undo();
});

// A session that reports itself unlocked on the control channel, as the
// managed SSH agent does. Nothing else is started.
async function unlockedSessionAt(inventoryPath: string) {
  const paths = sessionPaths(inventoryPath);
  await mkdir(paths.directory, { recursive: true });
  const server: Server = createServer((socket) => {
    socket.once("data", () => socket.end(JSON.stringify({ unlocked: true })));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.control, () => resolve());
  });
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(paths.directory, { recursive: true, force: true });
  });
}

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-managed-precheck-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function keepassMachine(managedInventory: string): Machine {
  return {
    description: "Synthetic SSH host",
    transport: "ssh",
    access: "full",
    address: "192.0.2.10",
    user: "operator",
    ssh_alias: "example",
    auth: {
      type: "keepassxc",
      inventory: managedInventory,
      socket: sessionPaths(managedInventory).socket,
      entry: "homectl-example",
      public_key: join(managedInventory, "..", "public-keys", "example.pub"),
    },
  };
}

test("the locked-session pre-check reads the worker's inventory, not the audit inventory", async () => {
  const dir = await directory();
  const auditInventory = join(dir, "audit", "inventory.yaml");
  const managedInventory = join(dir, "managed", "inventory.yaml");
  // The audit inventory's session is unlocked, but the worker checks the
  // managed inventory's session, which has no agent and is locked.
  await unlockedSessionAt(auditInventory);
  let runs = 0;
  let refusal: unknown;
  try {
    await execute("example", keepassMachine(managedInventory), ["hostname"], {
      configPath: join(dir, "ssh_config"),
      audit: { inventoryPath: auditInventory },
      runner: async () => {
        runs++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
  } catch (error) {
    refusal = error;
  }
  expect(runs).toBe(0);
  expect(refusal).toMatchObject({ code: 5 });
});

test("an unlocked managed session runs even when the audit inventory is locked", async () => {
  const dir = await directory();
  const auditInventory = join(dir, "audit", "inventory.yaml");
  const managedInventory = join(dir, "managed", "inventory.yaml");
  await unlockedSessionAt(managedInventory);
  let runs = 0;
  await execute("example", keepassMachine(managedInventory), ["hostname"], {
    configPath: join(dir, "ssh_config"),
    audit: { inventoryPath: auditInventory },
    runner: async () => {
      runs++;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  expect(runs).toBe(1);
});
