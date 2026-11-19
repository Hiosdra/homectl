import type { EventEnvelope } from "../core/contracts";
import { HomectlError } from "../types";
import type { AudienceFilter } from "./filter";
import { type EventLog, isGap, type SinceResult } from "./log";

export interface TransportOptions {
  // Resolves the audience for the request, or null when it is not authenticated.
  // The token must come from the Authorization header, never the URL.
  authenticate: (req: Request) => Promise<AudienceFilter | null>;
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const CATCH_UP_ATTEMPTS = 3;
const SEQ_DIGITS = /^\d{1,15}$/;
const LAST_EVENT_ID = /^(.+):(\d{1,15})$/;

export interface GapNotice {
  origin: string;
  firstRetainedSeq: number;
}

type Cursor = { after: number; lineage: boolean } | "invalid";

// Resumes from Last-Event-ID (sent automatically on EventSource reconnects) or
// from ?after=seq. An id from another origin means the client's state belongs
// to a different lineage, so the server sends a gap and the client resyncs.
export function resolveCursor(req: Request, origin: string): Cursor {
  const header = req.headers.get("last-event-id");
  if (header !== null && header !== "") {
    const match = LAST_EVENT_ID.exec(header);
    if (!match || match[1] !== origin) return { after: 0, lineage: true };
    return { after: Number(match[2]), lineage: false };
  }
  const raw = new URL(req.url).searchParams.get("after");
  if (raw === null) return { after: 0, lineage: false };
  if (!SEQ_DIGITS.test(raw)) return "invalid";
  return { after: Number(raw), lineage: false };
}

// Reads the retained events after the cursor. When the cursor is too old, or
// the client is on another lineage, it reports the gap and reads from the
// first retained seq so the client still receives everything it can.
async function catchUp(
  log: EventLog,
  after: number,
  filter: AudienceFilter,
  forced: boolean,
): Promise<{ firstRetainedSeq?: number; events: EventEnvelope[] }> {
  let from = after;
  let gapAt: number | undefined;
  if (forced) {
    gapAt = (await log.state()).firstRetainedSeq;
    from = gapAt - 1;
  }
  for (let attempt = 0; attempt < CATCH_UP_ATTEMPTS; attempt++) {
    const result: SinceResult = await log.since(from, filter);
    if (!isGap(result)) return { firstRetainedSeq: gapAt, events: result };
    gapAt = result.firstRetainedSeq;
    from = gapAt - 1;
  }
  throw new HomectlError(5, "Event log moved during catch-up; retry");
}

export function unauthorizedResponse(): Response {
  return new Response("unauthorized\n", {
    status: 401,
    headers: {
      "www-authenticate": 'Bearer realm="homectl-events"',
      "cache-control": "no-store",
    },
  });
}

async function authenticated(
  req: Request,
  authenticate: TransportOptions["authenticate"],
): Promise<AudienceFilter | null> {
  try {
    return await authenticate(req);
  } catch {
    // Fail closed: an authenticator that throws grants nothing.
    return null;
  }
}

export function sseHandler(
  log: EventLog,
  options: TransportOptions,
): (req: Request) => Promise<Response> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  return async (req) => {
    const filter = await authenticated(req, options.authenticate);
    if (!filter) return unauthorizedResponse();
    const cursor = resolveCursor(req, log.origin);
    if (cursor === "invalid")
      return new Response("invalid after\n", { status: 400 });

    // Subscribe before the catch-up read so nothing appended in between is lost.
    // Events seen before the stream is live are queued and deduplicated by seq.
    const queued: EventEnvelope[] = [];
    let live = false;
    let lastSent = cursor.after;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const emit = (text: string): void => {
      try {
        controller?.enqueue(encoder.encode(text));
      } catch {
        // The stream is already closed.
      }
    };
    const sendEvent = (envelope: EventEnvelope): void => {
      if (envelope.seq <= lastSent) return;
      lastSent = envelope.seq;
      emit(eventFrame(envelope));
    };
    const unsubscribe = log.subscribe((envelope) => {
      if (live) sendEvent(envelope);
      else queued.push(envelope);
    }, filter);

    let caught: Awaited<ReturnType<typeof catchUp>>;
    try {
      caught = await catchUp(log, cursor.after, filter, cursor.lineage);
    } catch (error) {
      unsubscribe();
      throw error;
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      try {
        controller?.close();
      } catch {
        // Already closed by the runtime.
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream;
        emit("retry: 1000\n\n");
        if (caught.firstRetainedSeq !== undefined)
          emit(gapFrame(log.origin, caught.firstRetainedSeq));
        for (const envelope of caught.events) sendEvent(envelope);
        for (const envelope of queued.splice(0)) sendEvent(envelope);
        live = true;
        heartbeat = setInterval(() => emit(": heartbeat\n\n"), heartbeatMs);
        heartbeat.unref?.();
        req.signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  };
}

// Polling fallback for clients whose stream keeps failing. Same catch-up rules
// as the stream, returned as JSON: { origin, gap, events }.
export function pollHandler(
  log: EventLog,
  options: Pick<TransportOptions, "authenticate">,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const filter = await authenticated(req, options.authenticate);
    if (!filter) return unauthorizedResponse();
    const cursor = resolveCursor(req, log.origin);
    if (cursor === "invalid")
      return new Response("invalid after\n", { status: 400 });
    const caught = await catchUp(log, cursor.after, filter, cursor.lineage);
    const gap: GapNotice | null =
      caught.firstRetainedSeq === undefined
        ? null
        : { origin: log.origin, firstRetainedSeq: caught.firstRetainedSeq };
    return Response.json(
      { origin: log.origin, gap, events: caught.events },
      { headers: { "cache-control": "no-store" } },
    );
  };
}

function eventFrame(envelope: EventEnvelope): string {
  return `id: ${envelope.id}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function gapFrame(origin: string, firstRetainedSeq: number): string {
  const notice: GapNotice = { origin, firstRetainedSeq };
  return `event: gap\ndata: ${JSON.stringify(notice)}\n\n`;
}
