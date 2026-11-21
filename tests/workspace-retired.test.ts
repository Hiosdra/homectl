// Evidence of clients that left the server (homelab #21 §6): a removed client
// keeps its last mirror as read-only history, the history is bounded, and a
// retired identity can never link again.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { EventEnvelope } from "../src/core/contracts";
import {
  MAX_RETIRED_EVENTS,
  isRetired,
  retiredRows,
  retireClient,
} from "../src/workspace/retired";
import type { ServerState } from "../src/workspace/state";
import {
  clientId,
  event,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  op,
  stepUp,
} from "./workspace-helpers";

interface Row {
  id: string;
  cause: string;
  historyKept: boolean;
  restorable: boolean;
  mirror: { lastSeq: number; events: number };
  pending: number;
}

let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

test("removing a client keeps its last mirror as read-only history", async () => {
  await link(h);
  const id = await clientId(h);
  h.events = [event(1), event(2), event(3)];
  h.ops = [op()];
  await h.client.syncOnce();

  await h.server.owner(
    "/v1/owner/workspace/remove",
    { client: id, password: OWNER_PASSWORD },
    stepUp,
  );

  const rows = (await h.server.owner(
    "/v1/owner/workspace/retired",
    {},
    stepUp,
  )) as Row[];
  expect(rows).toEqual([
    expect.objectContaining({
      id,
      cause: "removed",
      historyKept: true,
      restorable: true,
      mirror: expect.objectContaining({ lastSeq: 3, events: 3 }),
      pending: 1,
    }),
  ]);

  const history = (await h.server.owner(
    "/v1/owner/workspace/retired",
    { client: id },
    stepUp,
  )) as { events: EventEnvelope[]; pending: { id: string }[] };
  expect(history.events.map((item) => item.seq)).toEqual([1, 2, 3]);
  expect(history.pending.map((item) => item.id)).toEqual(["op-1"]);

  // Not a linked client any more, and not reachable as one.
  const linkedRows = (await h.server.owner(
    "/v1/owner/workspace/clients",
    {},
    stepUp,
  )) as { id: string }[];
  expect(linkedRows.map((row) => row.id)).not.toContain(id);
  await expect(
    h.server.owner("/v1/owner/workspace/events", { client: id }, stepUp),
  ).rejects.toThrow("Unknown workspace client");
  await expect(
    h.server.owner("/v1/owner/workspace/retired", { client: "nobody" }, stepUp),
  ).rejects.toThrow("No retired client with that id");
});

test("a removed identity is listed as removed and retired, so it cannot pair again", async () => {
  await link(h);
  const id = await clientId(h);
  await h.server.owner(
    "/v1/owner/workspace/remove",
    { client: id, password: OWNER_PASSWORD },
    stepUp,
  );
  const state = await h.serverState();
  expect(state.removed).toContain(id);
  expect(isRetired(state, id)).toBe(true);
});

function linkedClient(name: string, retiredAt: number, events: number) {
  return {
    name,
    platform: "linux",
    key: "00",
    joinedAt: 0,
    mirror: {
      lastSeq: events,
      events: Array.from({ length: events }, (_, index) => event(index + 1)),
      gaps: 0,
    },
    pending: [],
    intents: [],
    wrappedBackupKey: `wrapped-${name}-${retiredAt}`,
  };
}

test("the history kept for a retired client is bounded, and the oldest keep only their key", () => {
  const state: ServerState = {
    version: 1,
    id: "server",
    name: "server",
    custody: "00",
    clients: {},
    removed: [],
  };
  for (let index = 0; index < 25; index += 1) {
    const name = `client-${index}`;
    state.clients[name] = linkedClient(name, index, 600);
    retireClient(state, name, "removed", index);
  }

  const kept = state.retired?.["client-24"];
  expect(kept?.historyKept).toBe(true);
  expect(kept?.mirror.events).toHaveLength(MAX_RETIRED_EVENTS);
  // The newest events are the ones kept.
  expect(kept?.mirror.events.at(-1)?.seq).toBe(600);

  const oldest = state.retired?.["client-0"];
  expect(oldest?.historyKept).toBe(false);
  expect(oldest?.mirror.events).toHaveLength(0);
  expect(oldest?.pending).toHaveLength(0);
  // Its key stays, so its backups stay restorable.
  expect(oldest?.wrappedBackupKey).toBe("wrapped-client-0-0");

  const rows = retiredRows(state);
  expect(rows).toHaveLength(25);
  expect(rows.every((row) => row.restorable)).toBe(true);
  expect(rows.filter((row) => row.historyKept)).toHaveLength(20);
  expect(state.removed).toHaveLength(25);
});
