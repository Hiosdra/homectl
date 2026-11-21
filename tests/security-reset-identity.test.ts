// Stale identities after a reset restore (homelab #21 §6, "reset restore with
// fresh valid identity / no stale sessions"). Once a reset device has been
// restored, the old client identity is refused on the authenticated channel,
// its restore and backup requests fail, and the fresh identity works.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { channelRequest, type LinkPeer } from "../src/workspace/channel";
import {
  clientId,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  stepUp,
} from "./workspace-helpers";

const CANARY = "hosts:\n  lab-reset-canary-2d9b: {address: 10.8.8.8}\n";
let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function peerOf(harness: Harness): Promise<LinkPeer> {
  const linked = await harness.clientLink();
  return { id: linked.server?.id ?? "", key: linked.server?.key ?? "" };
}

test("after a reset restore the old identity is refused on the channel; the fresh one works", async () => {
  await link(h);
  const oldId = await clientId(h);
  const oldPeer = await peerOf(h);
  h.files = [
    { path: "inventory.yaml", data: bytes(CANARY) },
    { path: "known_hosts", data: bytes("lab ssh-ed25519 AAAA\n") },
    { path: "policy.json", data: bytes('{"rules":[]}\n') },
  ];
  expect((await h.client.backupOnce())?.seq).toBe(1);
  const issued = (await h.server.owner(
    "/v1/owner/workspace/restore",
    { client: oldId, seq: 1, reason: "laptop reset", password: OWNER_PASSWORD },
    stepUp,
  )) as { code: string };

  // Before and after the fresh identity joins, the old identity is refused.
  const refused = () =>
    channelRequest(h.post, oldId, oldPeer, "restore.status", {});
  await expect(refused()).rejects.toThrow("Unknown workspace client");
  await expect(h.client.backupOnce()).rejects.toThrow();

  const device = await h.freshDevice("reset-laptop");
  await device.client.owner(
    "/v1/owner/workspace/join",
    {
      address: "http://server.test:7451",
      code: issued.code,
      remoteApproval: false,
      password: OWNER_PASSWORD,
    },
    stepUp,
  );
  const fresh = await device.clientLink();
  expect(fresh.id).not.toBe(oldId);
  const freshPeer: LinkPeer = {
    id: fresh.server?.id ?? "",
    key: fresh.server?.key ?? "",
  };

  // The fresh identity completes an authenticated request and syncs.
  expect(
    await channelRequest(h.post, fresh.id, freshPeer, "restore.status", {}),
  ).toBeDefined();
  // syncOnce throws when the server refuses the identity.
  await device.client.syncOnce();

  // The old identity stays refused, and its backup cannot advance.
  await expect(refused()).rejects.toThrow("Unknown workspace client");
  h.files = [{ path: "inventory.yaml", data: bytes(`${CANARY}# changed\n`) }];
  await expect(h.client.backupOnce()).rejects.toThrow();
  const state = await h.serverState();
  expect(state.clients[oldId]).toBeUndefined();
  expect(state.removed).toContain(oldId);
});
