import type { EventEnvelope } from "../core/contracts";
import { HomectlError } from "../types";
import type { GapNotice } from "./transport";

export type ConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "polling"
  | "unauthorized"
  | "closed";

export interface ConnectEventsOptions {
  // Stream endpoint (sseHandler). ?after=seq is appended; the token is never put in the URL.
  url: string;
  token: string;
  after?: number;
  onEvent: (envelope: EventEnvelope) => void;
  onGap?: (gap: GapNotice) => void;
  onState?: (state: ConnectionState) => void;
  fetchImpl?: typeof fetch;
  // Polling endpoint (pollHandler). Used after the stream fails repeatedly.
  pollUrl?: string;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  // Consecutive stream failures before switching to polling.
  failuresBeforePolling?: number;
  // While polling, how often the stream is retried.
  streamRetryMs?: number;
}

export interface EventConnection {
  close(): void;
}

type StreamOutcome = "ended" | "failed" | "unauthorized";
type PollOutcome = "ok" | "gap" | "error" | "unauthorized";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_FAILURES_BEFORE_POLLING = 3;
const DEFAULT_STREAM_RETRY_MS = 30_000;

// Client for an authenticated event stream. Reconnects with exponential
// backoff, resumes from the last delivered seq, and falls back to bounded
// polling when the stream keeps failing. Duplicates are dropped by seq.
export function connectEvents(options: ConnectEventsOptions): EventConnection {
  if (options.token.length === 0)
    throw new HomectlError(2, "Event stream needs a token");
  if (
    options.url.includes(options.token) ||
    (options.pollUrl?.includes(options.token) ?? false)
  )
    throw new HomectlError(2, "Event stream token must not appear in a URL");

  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const fallbackAfter =
    options.failuresBeforePolling ?? DEFAULT_FAILURES_BEFORE_POLLING;
  const streamRetryMs = options.streamRetryMs ?? DEFAULT_STREAM_RETRY_MS;

  const abort = new AbortController();
  let cursor = options.after ?? 0;
  let failures = 0;
  let stopped = false;
  let wake: (() => void) | undefined;

  const state = (next: ConnectionState): void => {
    if (!stopped) safe(() => options.onState?.(next));
  };
  const stop = (final: ConnectionState): void => {
    if (stopped) return;
    stopped = true;
    safe(() => options.onState?.(final));
    abort.abort();
    wake?.();
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      wake = done;
      function done(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
    });

  const deliver = (envelope: EventEnvelope): void => {
    if (envelope.seq <= cursor) return;
    cursor = envelope.seq;
    safe(() => options.onEvent(envelope));
  };
  const applyGap = (gap: GapNotice): void => {
    // Rewind to just before the oldest retained event; the consumer resyncs via snapshot.
    cursor = gap.firstRetainedSeq - 1;
    safe(() => options.onGap?.(gap));
  };

  const authHeaders = (accept?: string): HeadersInit =>
    accept
      ? { authorization: `Bearer ${options.token}`, accept }
      : { authorization: `Bearer ${options.token}` };

  async function streamOnce(): Promise<StreamOutcome> {
    state("connecting");
    let response: Response;
    try {
      response = await fetchImpl(withAfter(options.url, cursor), {
        headers: authHeaders("text/event-stream"),
        signal: abort.signal,
      });
    } catch {
      return "failed";
    }
    if (response.status === 401) return "unauthorized";
    if (!response.ok || !response.body) return "failed";
    failures = 0;
    state("open");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) handleFrame(block);
      }
    } catch {
      // Aborted by close() or a dropped connection; the caller decides what next.
    }
    return "ended";
  }

  function handleFrame(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (event === "gap") {
      const gap = toGap(parsed);
      if (gap) applyGap(gap);
      return;
    }
    const envelope = toEnvelope(parsed);
    if (envelope) deliver(envelope);
  }

  async function pollOnce(): Promise<PollOutcome> {
    if (!options.pollUrl) return "error";
    let response: Response;
    try {
      response = await fetchImpl(withAfter(options.pollUrl, cursor), {
        headers: authHeaders("application/json"),
        signal: abort.signal,
      });
    } catch {
      return "error";
    }
    if (response.status === 401) return "unauthorized";
    if (!response.ok) return "error";
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return "error";
    }
    const parsed = toPollBody(body);
    if (!parsed) return "error";
    if (parsed.gap) applyGap(parsed.gap);
    for (const envelope of parsed.events) deliver(envelope);
    return parsed.gap ? "gap" : "ok";
  }

  // Returns "stream" to retry the stream, or "stop" when the connection ended.
  async function pollMode(): Promise<"stream" | "stop"> {
    state("polling");
    const started = Date.now();
    while (!stopped) {
      const outcome = await pollOnce();
      if (stopped) return "stop";
      if (outcome === "unauthorized") {
        stop("unauthorized");
        return "stop";
      }
      if (outcome === "gap") continue;
      if (Date.now() - started >= streamRetryMs) return "stream";
      await sleep(pollIntervalMs);
    }
    return "stop";
  }

  async function run(): Promise<void> {
    while (!stopped) {
      const outcome = await streamOnce();
      if (stopped) return;
      if (outcome === "unauthorized") {
        stop("unauthorized");
        return;
      }
      failures += 1;
      if (options.pollUrl && failures >= fallbackAfter) {
        if ((await pollMode()) === "stop") return;
        // One failed stream attempt sends the client back to polling.
        failures = fallbackAfter - 1;
        continue;
      }
      state("reconnecting");
      await sleep(backoff(failures));
    }
  }

  const backoff = (attempt: number): number =>
    Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempt - 1));

  void run();

  return {
    close() {
      stop("closed");
    },
  };
}

function withAfter(base: string, after: number): string {
  const url = new URL(base);
  url.searchParams.set("after", String(after));
  return url.toString();
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // A consumer callback must not break the connection loop.
  }
}

function toEnvelope(value: unknown): EventEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.origin !== "string" ||
    typeof record.type !== "string" ||
    typeof record.id !== "string" ||
    typeof record.seq !== "number" ||
    !Number.isSafeInteger(record.seq)
  )
    return undefined;
  return value as EventEnvelope;
}

function toGap(value: unknown): GapNotice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.origin !== "string" ||
    typeof record.firstRetainedSeq !== "number" ||
    !Number.isSafeInteger(record.firstRetainedSeq) ||
    record.firstRetainedSeq < 1
  )
    return undefined;
  return { origin: record.origin, firstRetainedSeq: record.firstRetainedSeq };
}

function toPollBody(
  value: unknown,
): { gap: GapNotice | null; events: EventEnvelope[] } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.events)) return undefined;
  const events: EventEnvelope[] = [];
  for (const item of record.events) {
    const envelope = toEnvelope(item);
    if (envelope) events.push(envelope);
  }
  const gap = record.gap === null ? null : toGap(record.gap);
  if (record.gap !== null && gap === undefined) return undefined;
  return { gap: gap ?? null, events };
}
