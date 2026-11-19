import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "../src/core/contracts";
import type { EventAppend } from "../src/events";
import {
  type AudienceFilter,
  type ConnectionState,
  connectEvents,
  type EventConnection,
  EventLog,
  type GapNotice,
  pollHandler,
  resolveCursor,
  sseHandler,
} from "../src/events";

const TOKENS: Record<string, AudienceFilter> = {
  "Bearer tok-owner": { owner: true },
  "Bearer tok-phone": { client: "phone" },
};

async function authenticate(req: Request): Promise<AudienceFilter | null> {
  return TOKENS[req.headers.get("authorization") ?? ""] ?? null;
}

async function tempDir(
  label: string,
): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), `homectl-events-${label}-`));
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function appendInput(
  subject: string,
  audience: string[] = [],
  data: unknown = { subject },
): EventAppend {
  return { type: "approval.requested", subject, audience, data };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

const cleanups: Array<() => Promise<void>> = [];
const stops: Array<() => void> = [];
afterEach(async () => {
  while (stops.length) stops.pop()?.();
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(label: string, maxRetained?: number) {
  const { directory, cleanup } = await tempDir(label);
  cleanups.push(cleanup);
  const log = new EventLog({
    directory,
    origin: "server-1",
    now: () => 1000,
    watchMs: 20,
    maxRetained,
  });
  return log;
}

// Serves the stream and poll endpoints on a loopback port chosen by the OS.
function serve(
  log: EventLog,
  options: { heartbeatMs?: number } = {},
): { base: string } {
  const stream = sseHandler(log, {
    authenticate,
    heartbeatMs: options.heartbeatMs ?? 1000,
  });
  const poll = pollHandler(log, { authenticate });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/stream") return stream(req);
      if (path === "/poll") return poll(req);
      return new Response("not found", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}` };
}

function track(connection: EventConnection): EventConnection {
  stops.push(() => connection.close());
  return connection;
}

function seqsOf(events: EventEnvelope[]): number[] {
  return events.map((event) => event.seq);
}

async function readUntil(
  response: Response,
  done: (text: string) => boolean,
): Promise<string> {
  if (!response.body) throw new Error("no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

describe("sseHandler stream", () => {
  test("delivers catch-up and live events; the token only travels in the header", async () => {
    const log = await fixture("live");
    for (const subject of ["a", "b", "c"])
      await log.append(appendInput(subject));
    const { base } = serve(log);

    const urls: string[] = [];
    const headers: Array<string | null> = [];
    const recording = ((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      headers.push(new Headers(init?.headers).get("authorization"));
      return fetch(input, init);
    }) as typeof fetch;

    const events: EventEnvelope[] = [];
    track(
      connectEvents({
        url: `${base}/stream`,
        token: "tok-owner",
        fetchImpl: recording,
        onEvent: (event) => events.push(event),
      }),
    );
    await waitFor(() => events.length === 3);
    expect(seqsOf(events)).toEqual([1, 2, 3]);

    await log.append(appendInput("d"));
    await waitFor(() => events.length === 4);
    expect(seqsOf(events)).toEqual([1, 2, 3, 4]);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).not.toContain("tok-owner");
    expect(headers.every((value) => value === "Bearer tok-owner")).toBe(true);
  });

  test("a reconnect resumes after the last delivered seq", async () => {
    const log = await fixture("resume");
    for (const subject of ["a", "b", "c"])
      await log.append(appendInput(subject));
    const { base } = serve(log);

    const first: EventEnvelope[] = [];
    const firstConn = track(
      connectEvents({
        url: `${base}/stream`,
        token: "tok-owner",
        onEvent: (event) => first.push(event),
      }),
    );
    await waitFor(() => first.length === 3);
    firstConn.close();

    await log.append(appendInput("d"));
    await log.append(appendInput("e"));

    const second: EventEnvelope[] = [];
    track(
      connectEvents({
        url: `${base}/stream`,
        token: "tok-owner",
        after: first[first.length - 1]?.seq ?? 0,
        onEvent: (event) => second.push(event),
      }),
    );
    await waitFor(() => second.length === 2);
    expect(seqsOf(second)).toEqual([4, 5]);
  });

  test("Last-Event-ID from the same origin is honoured", async () => {
    const log = await fixture("last-id");
    for (const subject of ["a", "b", "c", "d", "e"])
      await log.append(appendInput(subject));
    const { base } = serve(log);
    const response = await fetch(`${base}/stream`, {
      headers: {
        authorization: "Bearer tok-owner",
        "last-event-id": "server-1:3",
      },
    });
    const text = await readUntil(response, (value) =>
      value.includes("id: server-1:5"),
    );
    expect(text).toContain("id: server-1:4");
    expect(text).toContain("id: server-1:5");
    expect(text).not.toContain("id: server-1:3\n");
  });

  test("a client only sees events whose audience lists it", async () => {
    const log = await fixture("audience");
    await log.append(appendInput("for-phone", ["phone"]));
    await log.append(appendInput("for-laptop", ["laptop"]));
    await log.append(appendInput("owner-only", []));
    const { base } = serve(log);

    const phone: EventEnvelope[] = [];
    track(
      connectEvents({
        url: `${base}/stream`,
        token: "tok-phone",
        onEvent: (event) => phone.push(event),
      }),
    );
    await waitFor(() => phone.length === 1);
    await Bun.sleep(50);
    expect(seqsOf(phone)).toEqual([1]);
  });

  test("an unauthenticated request gets 401 and the client stops", async () => {
    const log = await fixture("unauth");
    await log.append(appendInput("a"));
    const { base } = serve(log);

    const response = await fetch(`${base}/stream`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");

    const states: ConnectionState[] = [];
    track(
      connectEvents({
        url: `${base}/stream`,
        token: "tok-wrong",
        onEvent: () => undefined,
        onState: (state) => states.push(state),
      }),
    );
    await waitFor(() => states.includes("unauthorized"));
    expect(states).not.toContain("open");
  });

  test("a gap is announced when catch-up is impossible", async () => {
    const log = await fixture("gap", 3);
    for (const subject of ["a", "b", "c", "d", "e", "f"])
      await log.append(appendInput(subject));
    const { base } = serve(log);

    const gaps: GapNotice[] = [];
    const events: EventEnvelope[] = [];
    track(
      connectEvents({
        url: `${base}/stream`,
        token: "tok-owner",
        after: 1,
        onEvent: (event) => events.push(event),
        onGap: (gap) => gaps.push(gap),
      }),
    );
    await waitFor(() => events.length === 3);
    expect(gaps).toEqual([{ origin: "server-1", firstRetainedSeq: 4 }]);
    expect(seqsOf(events)).toEqual([4, 5, 6]);
  });

  test("heartbeat comments keep an idle stream alive", async () => {
    const log = await fixture("heartbeat");
    const { base } = serve(log, { heartbeatMs: 20 });
    const response = await fetch(`${base}/stream`, {
      headers: { authorization: "Bearer tok-owner" },
    });
    const text = await readUntil(response, (value) =>
      value.includes(": heartbeat"),
    );
    expect(text).toContain(": heartbeat");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  test("a malformed after parameter is rejected", async () => {
    const log = await fixture("bad-after");
    const { base } = serve(log);
    const response = await fetch(`${base}/stream?after=abc`, {
      headers: { authorization: "Bearer tok-owner" },
    });
    expect(response.status).toBe(400);
    const cursor = resolveCursor(
      new Request("http://x/stream?after=7"),
      "server-1",
    );
    expect(cursor).toEqual({ after: 7, lineage: false });
  });
});

describe("polling fallback", () => {
  test("switches to polling after the stream fails three times in a row", async () => {
    const log = await fixture("poll");
    await log.append(appendInput("a"));
    await log.append(appendInput("b"));
    const { base } = serve(log);

    let streamAttempts = 0;
    const failingStream = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/stream")) {
        streamAttempts += 1;
        return Promise.reject(new Error("stream unreachable"));
      }
      return fetch(input, init);
    }) as typeof fetch;

    const events: EventEnvelope[] = [];
    const states: ConnectionState[] = [];
    track(
      connectEvents({
        url: `${base}/stream`,
        pollUrl: `${base}/poll`,
        token: "tok-owner",
        fetchImpl: failingStream,
        pollIntervalMs: 20,
        baseBackoffMs: 5,
        maxBackoffMs: 10,
        failuresBeforePolling: 3,
        streamRetryMs: 60_000,
        onEvent: (event) => events.push(event),
        onState: (state) => states.push(state),
      }),
    );
    await waitFor(() => events.length === 2);
    expect(seqsOf(events)).toEqual([1, 2]);
    expect(states).toContain("polling");
    expect(streamAttempts).toBe(3);

    await log.append(appendInput("c"));
    await waitFor(() => events.length === 3);
    expect(seqsOf(events)).toEqual([1, 2, 3]);
  });

  test("the poll endpoint returns the gap and the retained events", async () => {
    const log = await fixture("poll-gap", 2);
    for (const subject of ["a", "b", "c", "d"])
      await log.append(appendInput(subject));
    const { base } = serve(log);
    const response = await fetch(`${base}/poll?after=0`, {
      headers: { authorization: "Bearer tok-owner" },
    });
    const body = (await response.json()) as {
      origin: string;
      gap: GapNotice | null;
      events: EventEnvelope[];
    };
    expect(body.gap).toEqual({ origin: "server-1", firstRetainedSeq: 3 });
    expect(seqsOf(body.events)).toEqual([3, 4]);

    const denied = await fetch(`${base}/poll?after=0`);
    expect(denied.status).toBe(401);
  });
});

describe("connectEvents guards", () => {
  test("refuses a URL that contains the token", () => {
    expect(() =>
      connectEvents({
        url: "http://127.0.0.1:1/stream?token=tok-owner",
        token: "tok-owner",
        onEvent: () => undefined,
      }),
    ).toThrow();
  });
});
