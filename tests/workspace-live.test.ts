// Live owner events and the owner's intent status (homelab #21 §6, "Live UX").
// The server pushes approval.requested and approval.decided to its event port
// with an empty audience; the intents and pending routes show each decision's
// status. Client and server run in process, as in workspace-sync.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EventsPort } from "../src/broker/types";
import { audienceAllows } from "../src/events/filter";
import { HomectlError } from "../src/types";
import { requestedEvent } from "../src/workspace/live";
import { summarize } from "../src/workspace/summary";
import type { PendingSummary } from "../src/workspace/state";
import { parsePending } from "../src/workspace/validate";
import { logEvents } from "../src/workspace/wiring";
import {
  clientId,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  op,
  stepUp,
} from "./workspace-helpers";

interface Emitted {
  type: string;
  subject: string;
  audience: string[];
  data: Record<string, unknown>;
}

let emitted: Emitted[] = [];
let clock = 0;
let h: Harness;

const events: Pick<EventsPort, "emit"> = {
  emit: async (type, subject, audience, data) => {
    emitted.push({ type, subject, audience, data });
  },
};

beforeEach(async () => {
  emitted = [];
  clock = Date.now();
  h = await fixture({
    events,
    serverNow: () => clock,
    clientNow: () => clock,
  });
});
afterEach(async () => {
  await h.cleanup();
});

function ofType(type: string): Emitted[] {
  return emitted.filter((event) => event.type === type);
}

function decide(client: string, operationId: string, fingerprint: string) {
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
  ) as Promise<{ id: string; status: string }>;
}

function pendingRoute() {
  return h.server.owner("/v1/owner/workspace/pending", {}, stepUp) as Promise<
    Array<{ id: string; intent: null | { status: string; reason?: string } }>
  >;
}

function intentsRoute(input: Record<string, unknown> = {}) {
  return h.server.owner(
    "/v1/owner/workspace/intents",
    input,
    stepUp,
  ) as Promise<{
    intents: Array<Record<string, unknown> & { operationId: string }>;
  }>;
}

describe("approval.requested", () => {
  test("a new pending approval is announced once, under its canonical id", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [
      op({
        id: "op-1",
        argv: ["systemctl", "restart", "nginx"],
        narrative: "please restart nginx for the outage",
      }),
    ];
    await h.client.syncOnce();
    await h.client.syncOnce();

    const requested = ofType("approval.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.subject).toBe(`${id}:op-1`);
    expect(requested[0]?.data).toMatchObject({
      id: `${id}:op-1`,
      operationId: "op-1",
      client: id,
      host: "lab",
    });
  });

  test("the pushed data carries no argv, narrative or fingerprint", async () => {
    await link(h);
    h.ops = [
      op({
        id: "op-1",
        argv: ["systemctl", "restart", "nginx"],
        narrative: "restart the nginx unit now",
        fingerprint: "fp-secret-looking",
      }),
    ];
    await h.client.syncOnce();
    const [requested] = ofType("approval.requested");
    const text = JSON.stringify(requested?.data);
    expect(text).not.toContain("nginx");
    expect(text).not.toContain("restart the");
    expect(text).not.toContain("fp-secret-looking");
    expect(Object.keys(requested?.data ?? {}).sort()).toEqual([
      "client",
      "clientName",
      "expiresAt",
      "host",
      "humanOnly",
      "id",
      "operationId",
      "risk",
      "stepUp",
    ]);
  });

  test("an approval that has already expired is not announced", async () => {
    await link(h);
    h.ops = [op({ id: "op-old", expiresAt: clock - 1 })];
    await h.client.syncOnce();
    expect(ofType("approval.requested")).toHaveLength(0);
  });

  test("the event is owner-only: no linked client's audience matches it", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [op({ id: "op-1" })];
    await h.client.syncOnce();
    const [requested] = ofType("approval.requested");
    expect(requested?.audience).toEqual([]);
    expect(audienceAllows({ owner: true }, requested ?? { audience: [] })).toBe(
      true,
    );
    expect(audienceAllows({ client: id }, requested ?? { audience: [] })).toBe(
      false,
    );
    expect(
      audienceAllows({ client: "other-client" }, requested ?? { audience: [] }),
    ).toBe(false);
  });

  test("no push is made when the server has no event port; the routes still work", async () => {
    const quiet = await fixture();
    try {
      await link(quiet);
      quiet.ops = [op({ id: "op-1" })];
      await quiet.client.syncOnce();
      const rows = (await quiet.server.owner(
        "/v1/owner/workspace/pending",
        {},
        stepUp,
      )) as Array<{ id: string }>;
      expect(rows.map((row) => row.id)).toEqual(["op-1"]);
    } finally {
      await quiet.cleanup();
    }
  });
});

describe("approval.decided", () => {
  test("a decision applied on the client is announced once, as applied", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [op({ id: "op-1", fingerprint: "fp-1" })];
    await h.client.syncOnce();
    await decide(id, "op-1", "fp-1");
    await h.client.syncOnce();
    await h.client.syncOnce();

    expect(h.decisions).toHaveLength(1);
    const decided = ofType("approval.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      subject: `${id}:op-1`,
      audience: [],
      data: {
        id: `${id}:op-1`,
        operationId: "op-1",
        client: id,
        decision: "approve-once",
        status: "applied",
      },
    });
  });

  test("an intent that expires on the server is announced as refused with its reason", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [op({ id: "op-1", fingerprint: "fp-1" })];
    await h.client.syncOnce();
    await decide(id, "op-1", "fp-1");
    // Nobody syncs in time: the queued decision lapses.
    clock += 130_000;
    await h.client.syncOnce();

    const decided = ofType("approval.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]?.data).toMatchObject({
      status: "refused",
      reason: "expired",
    });
    expect(h.decisions).toHaveLength(0);
  });
});

describe("review state", () => {
  test("the pending route shows the decision source of an operation still under review", async () => {
    await link(h);
    const base = op({ id: "op-r" });
    h.ops = [{ ...base, decision: { ...base.decision, source: "review" } }];
    await h.client.syncOnce();
    const rows = (await h.server.owner(
      "/v1/owner/workspace/pending",
      {},
      stepUp,
    )) as Array<{ id: string; source?: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "op-r", source: "review" });
  });

  test("a pending summary keeps a known decision source and drops an unknown one", () => {
    const base = op({ id: "op-x" });
    const good = summarize({
      ...base,
      decision: { ...base.decision, source: "reviewer" },
    });
    expect(parsePending([good])[0]?.source).toBe("reviewer");
    // The item still arrives; only the unrecognised source is left out.
    const [item] = parsePending([{ ...good, source: "bogus" }]);
    expect(item?.id).toBe("op-x");
    expect(item?.source).toBeUndefined();
  });
});

describe("the default event port", () => {
  test("appends the live event to the broker's log with its owner-only audience", async () => {
    const appended: Array<Record<string, unknown>> = [];
    const port = logEvents({
      append: async (input) => {
        appended.push(input as unknown as Record<string, unknown>);
        return {} as never;
      },
    });
    const item: PendingSummary = {
      id: "op-7",
      client: "a1",
      host: "lab",
      argv: ["uptime"],
      risk: "R1",
      impact: "Reads state on lab",
      fingerprint: "fp-7",
      reason: "",
      stepUp: false,
      humanOnly: false,
      expiresAt: clock + 60_000,
    };
    const live = requestedEvent({ id: "a1", name: "laptop" }, item);
    await port.emit(live.type, live.subject, live.audience, live.data);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: "approval.requested",
      subject: "a1:op-7",
      audience: [],
    });
  });
});

describe("owner intents route", () => {
  test("decisions are listed newest first, with the fields the owner needs and nothing else", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [
      op({ id: "op-1", fingerprint: "fp-1" }),
      op({ id: "op-2", fingerprint: "fp-2" }),
      op({ id: "op-3", fingerprint: "fp-3" }),
    ];
    await h.client.syncOnce();
    for (const n of [1, 2, 3]) {
      clock += 1000;
      await decide(id, `op-${n}`, `fp-${n}`);
    }

    const { intents } = await intentsRoute();
    expect(intents.map((intent) => intent.operationId)).toEqual([
      "op-3",
      "op-2",
      "op-1",
    ]);
    expect(Object.keys(intents[0] ?? {}).sort()).toEqual([
      "client",
      "decision",
      "expiresAt",
      "id",
      "operationId",
      "status",
    ]);
    expect(intents[0]).toMatchObject({ client: id, status: "queued" });
  });

  test("the list is bounded and can be scoped to one client", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [
      op({ id: "op-1", fingerprint: "fp-1" }),
      op({ id: "op-2", fingerprint: "fp-2" }),
    ];
    await h.client.syncOnce();
    await decide(id, "op-1", "fp-1");
    clock += 1000;
    await decide(id, "op-2", "fp-2");

    expect((await intentsRoute({ limit: 1 })).intents).toHaveLength(1);
    expect((await intentsRoute({ client: id })).intents).toHaveLength(2);
    await expect(intentsRoute({ limit: 0 })).rejects.toBeInstanceOf(
      HomectlError,
    );
  });

  test("an unknown client is refused", async () => {
    await link(h);
    await expect(intentsRoute({ client: "no-such-client" })).rejects.toThrow(
      "Unknown workspace client",
    );
  });

  test("the status moves queued, delivered, applied, and the pending route shows it per item", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [op({ id: "op-1", fingerprint: "fp-1" })];
    await h.client.syncOnce();
    expect((await pendingRoute())[0]?.intent).toBeNull();

    await decide(id, "op-1", "fp-1");
    expect((await pendingRoute())[0]?.intent?.status).toBe("queued");

    // The next sync delivers the decision; the one after reports it applied.
    await h.client.syncOnce();
    expect((await intentsRoute()).intents[0]).toMatchObject({
      status: "applied",
    });
    expect((await pendingRoute())[0]?.intent?.status).toBe("applied");
  });

  test("a refused decision keeps its reason in both views", async () => {
    await link(h);
    const id = await clientId(h);
    h.ops = [op({ id: "op-1", fingerprint: "fp-1" })];
    await h.client.syncOnce();
    await decide(id, "op-1", "fp-1");
    clock += 130_000;
    await h.client.syncOnce();

    const [row] = (await intentsRoute()).intents;
    expect(row).toMatchObject({ status: "refused", reason: "expired" });
    const pending = await pendingRoute();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.intent).toMatchObject({
      status: "refused",
      reason: "expired",
    });
  });
});
