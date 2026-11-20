// Workspace pairing and the authenticated, encrypted channel (homelab #21 §6).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { channelRequest, type Post } from "../src/workspace/channel";
import {
  clientId,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  SERVER_ADDRESS,
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

async function peerOf(harness: Harness) {
  const state = await harness.clientLink();
  return {
    self: state.id,
    peer: { id: state.server?.id ?? "", key: state.server?.key ?? "" },
  };
}

test("pairing with the one-time code links the client and registers its key", async () => {
  await link(h);
  const state = await h.serverState();
  const linkState = await h.clientLink();
  expect(linkState.server?.id).toBe(state.id);
  expect(Object.keys(state.clients)).toEqual([linkState.id]);
  // The link key is the same on both sides; it is never returned by owner routes.
  expect(state.clients[linkState.id]?.key).toBe(linkState.server?.key);
  const clients = await h.server.owner(
    "/v1/owner/workspace/clients",
    {},
    stepUp,
  );
  expect(JSON.stringify(clients)).not.toContain(linkState.server?.key ?? "");
});

test("a successful authenticated request returns the server's answer", async () => {
  await link(h);
  const { self, peer } = await peerOf(h);
  const reply = await channelRequest(h.post, self, peer, "backup.missing", {
    ids: [],
  });
  expect(reply).toEqual([]);
});

test("a wrong code fails and invalidates the open invite", async () => {
  const invite = (await h.server.owner(
    "/v1/owner/workspace/invite",
    { password: OWNER_PASSWORD },
    stepUp,
  )) as { code: string };
  const wrong = invite.code === "1111-2222" ? "2222-3333" : "1111-2222";
  const join = (code: string) =>
    h.client.owner(
      "/v1/owner/workspace/join",
      {
        address: SERVER_ADDRESS,
        code,
        remoteApproval: false,
        password: OWNER_PASSWORD,
      },
      stepUp,
    );
  await expect(join(wrong)).rejects.toThrow("Pairing authentication failed");
  // The right code no longer works: the failed proof closed the window.
  await expect(join(invite.code)).rejects.toThrow();
  expect((await h.clientLink()).server).toBeUndefined();
});

test("a replayed message is rejected", async () => {
  await link(h);
  const { self, peer } = await peerOf(h);
  const sent: { path: string; value: unknown }[] = [];
  h.post = async (path, value) => {
    sent.push({ path, value });
    return h.server.network(path, value);
  };
  await channelRequest(h.post, self, peer, "backup.missing", { ids: [] });
  const message = sent
    .filter((item) => item.path === "/v1/workspace/message")
    .at(-1);
  expect(message).toBeDefined();
  await expect(
    h.server.network(message?.path ?? "", message?.value),
  ).rejects.toThrow("expired/replayed");
});

test("a removed client is rejected and cannot rejoin with its identity", async () => {
  await link(h);
  const id = await clientId(h);
  const { self, peer } = await peerOf(h);
  await h.server.owner(
    "/v1/owner/workspace/remove",
    { client: id, password: OWNER_PASSWORD },
    stepUp,
  );
  await expect(
    channelRequest(h.post, self, peer, "backup.missing", { ids: [] }),
  ).rejects.toThrow();
  // Leave and try to pair again with the same identity.
  await h.client.owner(
    "/v1/owner/workspace/leave",
    { password: OWNER_PASSWORD },
    stepUp,
  );
  const invite = (await h.server.owner(
    "/v1/owner/workspace/invite",
    { password: OWNER_PASSWORD },
    stepUp,
  )) as { code: string };
  await expect(
    h.client.owner(
      "/v1/owner/workspace/join",
      {
        address: SERVER_ADDRESS,
        code: invite.code,
        remoteApproval: false,
        password: OWNER_PASSWORD,
      },
      stepUp,
    ),
  ).rejects.toThrow();
  expect((await h.clientLink()).server).toBeUndefined();
});

test("a tampered envelope is rejected", async () => {
  await link(h);
  const { self, peer } = await peerOf(h);
  h.post = async (path, value) => {
    if (path !== "/v1/workspace/message") return h.server.network(path, value);
    const body = value as { envelope: { data: string } } & Record<
      string,
      unknown
    >;
    const data = body.envelope.data;
    const flipped = (data[0] === "A" ? "B" : "A") + data.slice(1);
    return h.server.network(path, {
      ...body,
      envelope: { ...body.envelope, data: flipped },
    });
  };
  await expect(
    channelRequest(h.post, self, peer, "backup.missing", { ids: [] }),
  ).rejects.toThrow();
});

test("a challenge proof made with the wrong key is rejected by the client", async () => {
  await link(h);
  const { self, peer } = await peerOf(h);
  const serverSelf = await serverId(h);
  const wrongKey = Buffer.alloc(32, 9);
  const forged: Post = async (path, value) => {
    const reply = (await h.server.network(path, value)) as Record<
      string,
      string
    >;
    if (path !== "/v1/workspace/challenge") return reply;
    const message = `workspace-challenge-v1:${self}:${serverSelf}:${reply.challenge}:${reply.publicKey}`;
    return {
      ...reply,
      proof: createHmac("sha256", wrongKey).update(message).digest("hex"),
    };
  };
  await expect(
    channelRequest(forged, self, peer, "backup.missing", { ids: [] }),
  ).rejects.toThrow("Workspace server authentication failed");
});
