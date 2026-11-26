import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clientId,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  SERVER_ADDRESS,
  stepUp,
} from "./workspace-helpers";

let h: Harness;
beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

async function restoreDevice() {
  await link(h);
  const client = await clientId(h);
  h.files = [
    { path: "inventory.yaml", data: Buffer.from("inventory snapshot") },
    { path: "known_hosts", data: Buffer.from("trusted host keys") },
  ];
  await h.client.backupOnce();
  const result = (await h.server.owner(
    "/v1/owner/workspace/restore",
    {
      client,
      seq: 1,
      reason: "Interrupted restore test",
      password: OWNER_PASSWORD,
    },
    stepUp,
  )) as { code: string };
  const device = await h.freshDevice("reset-device");
  return {
    ...device,
    join: () =>
      device.client.owner(
        "/v1/owner/workspace/join",
        {
          address: SERVER_ADDRESS,
          code: result.code,
          remoteApproval: false,
          password: OWNER_PASSWORD,
        },
        stepUp,
      ),
  };
}

test("a reset device resumes after file installation without writing the files again", async () => {
  const device = await restoreDevice();
  const write = device.restore.write;
  let attempts = 0;
  device.restore.write = async (files) => {
    attempts += 1;
    await write(files);
    throw new Error("Interrupted immediately after installation");
  };
  expect(await device.join()).toMatchObject({
    restore: {
      status: "failed",
      reason: "Workspace request failed",
    },
  });
  const receipt = await device.clientLink();
  expect(receipt.restore?.expected).toHaveLength(2);

  await device.client.syncOnce();
  expect(attempts).toBe(1);
  expect((await device.clientLink()).restore).toBeUndefined();
  expect((await h.serverState()).clients[receipt.id]?.restore).toBeUndefined();
});

test("a changed or missing restored file blocks acknowledgment without overwriting local files", async () => {
  const device = await restoreDevice();
  const write = device.restore.write;
  device.restore.write = async (files) => {
    await write(files);
    throw new Error("Interrupted after installing the files");
  };
  await device.join();
  const receipt = await device.clientLink();
  const inventory = device.restore.written.get("inventory.yaml");
  if (!inventory) throw new Error("Expected the installed inventory");
  const existing = Buffer.from("local inventory changed after restore");
  device.restore.written.set("inventory.yaml", existing);
  await device.client.syncOnce();
  expect(device.restore.written.get("inventory.yaml")).toBe(existing);
  expect((await h.serverState()).clients[receipt.id]?.restore).toBeDefined();

  device.restore.written.set("inventory.yaml", inventory);
  device.restore.written.delete("known_hosts");
  await device.client.syncOnce();
  expect(device.restore.written.get("inventory.yaml")).toBe(inventory);
  expect(device.restore.written.has("known_hosts")).toBe(false);
  expect((await device.clientLink()).restore).toEqual(receipt.restore);
  expect((await h.serverState()).clients[receipt.id]?.restore).toBeDefined();
});
