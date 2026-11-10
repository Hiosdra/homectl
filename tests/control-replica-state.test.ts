import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import { ControlPlane, controlStateDirectory } from "../src/control/engine";
import { ControlReplicator, loadReplicaFile } from "../src/control/replicator";
import { HomectlError } from "../src/types";

// Synthetic device with an empty inventory; nothing here contacts a peer.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function device() {
  const root = await mkdtemp(join(tmpdir(), "homectl-replica-state-"));
  dirs.push(root);
  const inventoryPath = join(root, "inventory.yaml");
  await writeFile(
    inventoryPath,
    `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`,
  );
  const configPath = `${inventoryPath}.ssh_config`;
  const stateDirectory = controlStateDirectory(inventoryPath);
  await mkdir(stateDirectory, { recursive: true });
  const plane = new ControlPlane({ inventoryPath, configPath, stateDirectory });
  await plane.init();
  const key = await loadOrCreateDeviceKey(join(root, "device"));
  return {
    stateDirectory,
    plane,
    self: {
      id: "00000000-0000-4000-8000-0000000000aa",
      name: "synthetic",
      key,
    },
    replicaPath: join(stateDirectory, "replica.json"),
  };
}

async function refusal(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HomectlError ? error.code : undefined;
  }
  return undefined;
}

describe("replica state file", () => {
  test("a missing replica.json starts fresh", async () => {
    const d = await device();
    await ControlReplicator.open({
      plane: d.plane,
      stateDirectory: d.stateDirectory,
      self: d.self,
    });
    expect(JSON.parse(await readFile(d.replicaPath, "utf8")).version).toBe(1);
  });

  test("malformed JSON refuses to start and is preserved byte-for-byte", async () => {
    const d = await device();
    const damaged = Buffer.from('{"version":1,"replica":{"ops":{"half');
    await writeFile(d.replicaPath, damaged);
    const code = await refusal(
      ControlReplicator.open({
        plane: d.plane,
        stateDirectory: d.stateDirectory,
        self: d.self,
      }),
    );
    expect(code).toBe(5);
    expect(Buffer.from(await readFile(d.replicaPath))).toEqual(damaged);
  });

  test("an unreadable replica.json (not a file) refuses to start and is not overwritten", async () => {
    const d = await device();
    // A directory where the file should be: readable as a path, not as JSON.
    await mkdir(d.replicaPath, { recursive: true });
    const code = await refusal(
      ControlReplicator.open({
        plane: d.plane,
        stateDirectory: d.stateDirectory,
        self: d.self,
      }),
    );
    expect(code).toBe(5);
    expect((await stat(d.replicaPath)).isDirectory()).toBe(true);
  });

  test("the read-only loader refuses malformed state instead of treating it as empty", async () => {
    const d = await device();
    await writeFile(d.replicaPath, "not json");
    expect(await refusal(loadReplicaFile(d.stateDirectory))).toBe(5);
    expect(await readFile(d.replicaPath, "utf8")).toBe("not json");
  });

  test("the read-only loader reports a missing file as nothing replicated yet", async () => {
    const d = await device();
    expect(await loadReplicaFile(d.stateDirectory)).toBeUndefined();
  });
});
