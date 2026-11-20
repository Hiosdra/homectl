// Mirrored status, queued owner decisions and their application through the
// client's own engine (homelab #21 §6). Client and server run in process.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { EventEnvelope } from "../src/core/contracts";
import { clientLinkFile, serverStateFile } from "../src/workspace/state";
import {
  clientId,
  event,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  op,
  serverId,
  stepUp,
} from "./workspace-helpers";

let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

function queue(client: string, operationId: string, fingerprint: string) {
  return h.server.owner(
    "/v1/owner/workspace/decide",
    {
      client,
      operationId,
      fingerprint,
      decision: "approve-once",
      password: OWNER_PASSWORD,
    },
    stepUp,
  ) as Promise<{ id: string; status: string; stepUp: boolean }>;
}

async function intentStatus(client: string) {
  const state = await h.serverState();
  return state.clients[client]?.intents.at(-1);
}

test("events are mirrored in order and the client's position is acknowledged", async () => {
  await link(h);
  const id = await clientId(h);
  h.events.push(event(1), event(2), event(3));
  await h.client.syncOnce();
  const mirrored = (await h.server.owner(
    "/v1/owner/workspace/events",
    { client: id },
    stepUp,
  )) as EventEnvelope[];
  expect(mirrored.map((item) => item.seq)).toEqual([1, 2, 3]);
  expect((await h.clientLink()).eventsAcked).toBe(3);

  // Only the new tail is sent; nothing is mirrored twice.
  h.events.push(event(4));
  await h.client.syncOnce();
  const again = (await h.server.owner(
    "/v1/owner/workspace/events",
    { client: id, after: 2 },
    stepUp,
  )) as EventEnvelope[];
  expect(again.map((item) => item.seq)).toEqual([3, 4]);
});

test("a local event gap is noted on the client and never silently skipped", async () => {
  await link(h);
  h.events.push(event(1), event(2), event(3));
  await h.client.syncOnce();
  h.gapFrom = 10;
  await h.client.syncOnce();
  const linkState = await h.clientLink();
  // The server still holds 1..3, so its acknowledgement wins.
  expect(linkState.eventsAcked).toBe(3);
  expect(linkState.lastSyncError).toContain("pruned");
});

test("pending operations appear on the server, tagged with their origin", async () => {
  await link(h);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1", narrative: "please" }));
  await h.client.syncOnce();
  const pending = (await h.server.owner(
    "/v1/owner/workspace/pending",
    {},
    stepUp,
  )) as {
    id: string;
    origin: string;
    originName: string;
    narrative?: { untrusted: string };
  }[];
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    id: "op-1",
    origin: id,
    fingerprint: "fp-1",
    narrative: { untrusted: "please" },
  });
  expect(typeof pending[0]?.originName).toBe("string");
});

test("the owner's decision is queued on the server", async () => {
  await link(h);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1" }));
  await h.client.syncOnce();
  const intent = await queue(id, "op-1", "fp-1");
  expect(intent.status).toBe("queued");
  expect(intent.stepUp).toBe(true);
});

test("a client with remote approval applies the decision through its engine", async () => {
  await link(h, true);
  const id = await clientId(h);
  const sid = await serverId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1" }));
  await h.client.syncOnce();
  await queue(id, "op-1", "fp-1");
  await h.client.syncOnce();
  expect(h.decisions).toEqual([
    {
      operationId: "op-1",
      fingerprint: "fp-1",
      decision: "approve-once",
      surface: `workspace-server:${sid}`,
      stepUp: true,
    },
  ]);
  // The second round of that sync reported the outcome back.
  expect((await intentStatus(id))?.status).toBe("applied");
});

test("a client without remote approval refuses the queued decision", async () => {
  await link(h, true);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1" }));
  await h.client.syncOnce();
  await queue(id, "op-1", "fp-1");
  // The owner turned remote approval off on this device after queueing.
  await clientLinkFile(h.clientDir).update((state) => {
    if (state.server) state.server.remoteApproval = false;
  });
  await h.client.syncOnce();
  expect(h.decisions).toEqual([]);
  const intent = await intentStatus(id);
  expect(intent?.status).toBe("refused");
  expect(intent?.reason).toBe("remote approval not granted on this client");
});

test("a decision delivered again after it was applied is applied only once", async () => {
  await link(h, true);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1" }));
  await h.client.syncOnce();
  await queue(id, "op-1", "fp-1");
  await h.client.syncOnce();
  expect(h.decisions).toHaveLength(1);
  // Simulate a lost outcome: the server still shows the intent as open.
  await serverStateFile(h.serverDir).update((state) => {
    const intent = state.clients[id]?.intents.at(-1);
    if (intent) intent.status = "delivered";
  });
  await h.client.syncOnce();
  expect(h.decisions).toHaveLength(1);
});

test("a decision is refused on the server for a fingerprint mismatch", async () => {
  await link(h, true);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1" }));
  await h.client.syncOnce();
  await expect(queue(id, "op-1", "other")).rejects.toThrow(
    "not waiting for approval with this fingerprint",
  );
});

test("a decision is refused on the server for an unknown client", async () => {
  await link(h, true);
  await expect(
    queue("00000000-0000-4000-8000-000000000000", "op-1", "fp-1"),
  ).rejects.toThrow("Unknown workspace client");
});

test("a decision is refused on the server when the client has no remote approval", async () => {
  await link(h, false);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1" }));
  await h.client.syncOnce();
  await expect(queue(id, "op-1", "fp-1")).rejects.toThrow(
    "does not accept approvals",
  );
});

test("an intent past its expiry is refused by the server before delivery", async () => {
  let now = 1_000_000;
  h = await fixture({ serverNow: () => now, clientNow: () => now });
  await link(h, true);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1", expiresAt: now + 600_000 }));
  await h.client.syncOnce();
  await queue(id, "op-1", "fp-1");
  now += 200_000;
  await h.client.syncOnce();
  expect(h.decisions).toEqual([]);
  expect(await intentStatus(id)).toMatchObject({
    status: "refused",
    reason: "expired",
  });
});

test("the client refuses an intent that expired by its own clock", async () => {
  const serverClock = 1_000_000;
  const clientClock = { now: 1_000_000 };
  h = await fixture({
    serverNow: () => serverClock,
    clientNow: () => clientClock.now,
  });
  await link(h, true);
  const id = await clientId(h);
  h.ops.push(op({ id: "op-1", fingerprint: "fp-1", expiresAt: 9_000_000 }));
  await h.client.syncOnce();
  await queue(id, "op-1", "fp-1");
  clientClock.now += 130_000;
  await h.client.syncOnce();
  expect(h.decisions).toEqual([]);
  expect(await intentStatus(id)).toMatchObject({
    status: "refused",
    reason: "expired",
  });
});
