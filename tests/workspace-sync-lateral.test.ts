// No lateral approval on the workspace server (homelab #21 §6): a decision
// queued for one linked client applies only to that client's own waiting
// operation, even when another client holds an operation with the same id
// and fingerprint.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { serverStateFile } from "../src/workspace/state";
import {
  clientId,
  fixture,
  type FreshDevice,
  type Harness,
  link,
  OWNER_PASSWORD,
  op,
  SERVER_ADDRESS,
  stepUp,
} from "./workspace-helpers";

let h: Harness;
let second: FreshDevice;

beforeEach(async () => {
  h = await fixture();
  await link(h, true);
  second = await h.freshDevice("laptop-b");
  const invite = (await h.server.owner(
    "/v1/owner/workspace/invite",
    { password: OWNER_PASSWORD },
    stepUp,
  )) as { code: string };
  await second.client.owner(
    "/v1/owner/workspace/join",
    {
      address: SERVER_ADDRESS,
      code: invite.code,
      remoteApproval: true,
      password: OWNER_PASSWORD,
    },
    stepUp,
  );
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
  );
}

async function intentsOf(client: string) {
  const state = await serverStateFile(h.serverDir).read();
  return state.clients[client]?.intents ?? [];
}

test("a decision for one client cannot be queued against another client's operation", async () => {
  const first = await clientId(h);
  const other = (await second.clientLink()).id;
  // Same id and fingerprint on A; B holds only a different operation.
  h.ops = [op({ id: "op-1", fingerprint: "fp-1" })];
  await h.client.syncOnce();
  h.ops = [op({ id: "op-2", fingerprint: "fp-1" })];
  await second.client.syncOnce();

  await expect(queue(other, "op-1", "fp-1")).rejects.toThrow(
    "not waiting for approval with this fingerprint",
  );
  expect(await intentsOf(other)).toEqual([]);

  await queue(first, "op-1", "fp-1");
  expect((await intentsOf(first)).map((i) => i.operationId)).toEqual(["op-1"]);
  expect(await intentsOf(other)).toEqual([]);
});

test("only the client that holds the queued decision applies it", async () => {
  const first = await clientId(h);
  const other = (await second.clientLink()).id;
  h.ops = [op({ id: "op-1", fingerprint: "fp-1" })];
  await h.client.syncOnce();
  h.ops = [op({ id: "op-2", fingerprint: "fp-1" })];
  await second.client.syncOnce();
  await queue(first, "op-1", "fp-1");

  // B syncs: it must not pick up A's intent.
  await second.client.syncOnce();
  expect(h.decisions).toEqual([]);
  expect(await intentsOf(other)).toEqual([]);

  await h.client.syncOnce();
  expect(h.decisions).toHaveLength(1);
  expect(h.decisions[0]?.operationId).toBe("op-1");

  // B later holds its own op-1 with the same fingerprint: that is a separate
  // decision, applied once, and A's intent is not reused for it.
  h.ops = [op({ id: "op-1", fingerprint: "fp-1" })];
  await second.client.syncOnce();
  await queue(other, "op-1", "fp-1");
  await second.client.syncOnce();
  expect(h.decisions).toHaveLength(2);
  expect(await intentsOf(first)).toHaveLength(1);
  expect(await intentsOf(other)).toHaveLength(1);
});
