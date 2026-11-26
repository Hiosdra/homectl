import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectoryOnce, withFileLock } from "../control/file-lock";
import {
  CLIENT_ID_PATTERN,
  EVENT_TYPES,
  type EventEnvelope,
  type EventType,
} from "../core/contracts";
import { HomectlError } from "../types";
import {
  type AudienceFilter,
  assertFilter,
  audienceAllows,
  OWNER_FILTER,
} from "./filter";
import { readTextIfExists, writeTextAtomic } from "./fs";
import {
  corruptLog,
  listSegments,
  parseSegment,
  type Segment,
  segmentFileName,
} from "./segments";

export const MAX_EVENT_DATA_BYTES = 64 * 1024;
const MAX_SEGMENT_EVENTS = 1000;
const MAX_SUBJECT_LENGTH = 256;
const DEFAULT_MAX_RETAINED = 10_000;
const DEFAULT_WATCH_MS = 1000;
const READ_ATTEMPTS = 3;

export interface EventAppend {
  type: EventType;
  subject: string;
  audience: string[];
  data: unknown;
}

export interface EventLogOptions {
  directory: string;
  origin: string;
  now?: () => number;
  maxRetained?: number;
  // How often live subscribers look for appends made by other processes.
  watchMs?: number;
}

export interface LogState {
  head: number;
  firstRetainedSeq: number;
}

export interface EventGap {
  gap: true;
  firstRetainedSeq: number;
}

export type SinceResult = EventEnvelope[] | EventGap;
export type EventListener = (envelope: EventEnvelope) => void;

interface Subscriber {
  listener: EventListener;
  filter: AudienceFilter;
}

interface NormalizedAppend {
  type: EventType;
  subject: string;
  audience: string[];
  data: unknown;
}

const RETRY = Symbol("retry");

export function isGap(result: SinceResult): result is EventGap {
  return !Array.isArray(result);
}

// File-backed event log for one origin device. Seq is strictly +1 per append,
// persisted in the segment files, so it survives restarts.
export class EventLog {
  readonly origin: string;
  readonly directory: string;
  readonly maxRetained: number;
  private readonly now: () => number;
  private readonly watchMs: number;
  private readonly lockPath: string;
  private readonly segmentEvents: number;
  private readonly subscribers = new Set<Subscriber>();
  private chain: Promise<unknown> = Promise.resolve();
  private watermark: number | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;

  constructor(options: EventLogOptions) {
    if (
      typeof options.origin !== "string" ||
      options.origin.length === 0 ||
      /[:\s]/.test(options.origin)
    )
      throw new HomectlError(2, "Event log origin must be a device id");
    const maxRetained = options.maxRetained ?? DEFAULT_MAX_RETAINED;
    if (!Number.isSafeInteger(maxRetained) || maxRetained < 1)
      throw new HomectlError(2, "maxRetained must be a positive integer");
    this.origin = options.origin;
    this.directory = options.directory;
    this.maxRetained = maxRetained;
    this.now = options.now ?? Date.now;
    this.watchMs = options.watchMs ?? DEFAULT_WATCH_MS;
    this.lockPath = join(options.directory, ".events.lock");
    this.segmentEvents = Math.min(MAX_SEGMENT_EVENTS, maxRetained);
  }

  // Serialized in-process; withFileLock serializes separate processes.
  async append(input: EventAppend): Promise<EventEnvelope> {
    const normalized = normalizeAppend(input);
    return this.enqueue(async () => {
      await ensurePrivateDirectoryOnce(this.directory);
      const envelope = await withFileLock(this.lockPath, "Event log", () =>
        this.writeLocked(normalized),
      );
      await this.deliverPending().catch(() => undefined);
      return envelope;
    });
  }

  // Events with seq > after that the filter allows, or a gap when the events
  // needed to continue have already been pruned.
  async since(
    after: number,
    filter: AudienceFilter = OWNER_FILTER,
  ): Promise<SinceResult> {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new HomectlError(2, "Event cursor must be a non-negative integer");
    assertFilter(filter);
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const result = await this.readSince(after, filter);
      if (result !== RETRY) return result;
    }
    throw new HomectlError(5, "Event log changed during read; retry");
  }

  async state(): Promise<LogState> {
    const segments = await listSegments(this.directory);
    const newest = segments.at(-1);
    if (!newest) return { head: 0, firstRetainedSeq: 1 };
    const text = await readTextIfExists(newest.path);
    if (text === undefined) throw corruptLog();
    const head =
      newest.firstSeq +
      parseSegment(text, newest, this.origin).events.length -
      1;
    return { head, firstRetainedSeq: this.firstRetainedFor(head) };
  }

  // Live delivery. Appends made by this instance are delivered at once; appends
  // from other processes are picked up by a watcher. Returns an unsubscribe.
  subscribe(
    listener: EventListener,
    filter: AudienceFilter = OWNER_FILTER,
  ): () => void {
    assertFilter(filter);
    const subscriber: Subscriber = { listener, filter };
    if (this.subscribers.size === 0) {
      this.watermark = undefined;
      // Queued behind earlier appends, so the watermark is exact.
      void this.enqueue(async () => {
        if (this.subscribers.size > 0 && this.watermark === undefined)
          this.watermark = (await this.state()).head;
      }).catch(() => undefined);
      this.watcher = setInterval(() => {
        void this.enqueue(() => this.deliverPending()).catch(() => undefined);
      }, this.watchMs);
      this.watcher.unref?.();
    }
    this.subscribers.add(subscriber);
    return () => {
      if (!this.subscribers.delete(subscriber) || this.subscribers.size > 0)
        return;
      if (this.watcher) clearInterval(this.watcher);
      this.watcher = undefined;
      this.watermark = undefined;
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => task());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private firstRetainedFor(head: number): number {
    return Math.max(1, head - this.maxRetained + 1);
  }

  private async readSince(
    after: number,
    filter: AudienceFilter,
  ): Promise<SinceResult | typeof RETRY> {
    const segments = await listSegments(this.directory);
    const newest = segments.at(-1);
    if (!newest) return [];
    // Skip segments that hold only events at or before `after`.
    const selected = segments.filter((_segment, index) => {
      const next = segments[index + 1];
      return next === undefined || next.firstSeq > after + 1;
    });
    const events: EventEnvelope[] = [];
    let newestCount = 0;
    for (const segment of selected) {
      const text = await readTextIfExists(segment.path);
      // Pruned by another process between listing and reading.
      if (text === undefined) return RETRY;
      const parsed = parseSegment(text, segment, this.origin);
      if (segment === newest) newestCount = parsed.events.length;
      for (const envelope of parsed.events)
        if (envelope.seq > after && audienceAllows(filter, envelope))
          events.push(envelope);
    }
    const head = newest.firstSeq + newestCount - 1;
    const first = this.firstRetainedFor(head);
    if (after + 1 < first) return { gap: true, firstRetainedSeq: first };
    return events;
  }

  private async writeLocked(input: NormalizedAppend): Promise<EventEnvelope> {
    const segments = await listSegments(this.directory);
    const newest = segments.at(-1);
    let head = 0;
    let newestCount = 0;
    if (newest) {
      const text = await readTextIfExists(newest.path);
      if (text === undefined) throw corruptLog();
      const parsed = parseSegment(text, newest, this.origin);
      // Drop a torn tail left by an interrupted append before writing after it.
      if (parsed.partial) await writeTextAtomic(newest.path, parsed.complete);
      newestCount = parsed.events.length;
      head = newest.firstSeq + newestCount - 1;
    }
    const seq = head + 1;
    const envelope: EventEnvelope = {
      id: `${this.origin}:${seq}`,
      origin: this.origin,
      seq,
      at: this.now(),
      type: input.type,
      subject: input.subject,
      audience: input.audience,
      data: input.data,
    };
    const line = `${JSON.stringify(envelope)}\n`;
    let all: Segment[];
    if (newest && newestCount < this.segmentEvents) {
      await appendFile(newest.path, line);
      all = segments;
    } else {
      // Rotation: the new segment is written whole, then renamed into place.
      const segment: Segment = {
        path: join(this.directory, segmentFileName(seq)),
        firstSeq: seq,
      };
      await writeTextAtomic(segment.path, line);
      all = [...segments, segment];
    }
    await this.prune(all, seq);
    return envelope;
  }

  // Removes a segment only when every event in it is outside the retention window.
  private async prune(segments: Segment[], head: number): Promise<void> {
    const first = this.firstRetainedFor(head);
    for (let index = 0; index + 1 < segments.length; index++) {
      const current = segments[index];
      const next = segments[index + 1];
      if (!current || !next || next.firstSeq > first) break;
      await rm(current.path, { force: true });
    }
  }

  private async deliverPending(): Promise<void> {
    const from = this.watermark;
    if (from === undefined || this.subscribers.size === 0) return;
    const result = await this.since(from);
    if (isGap(result)) {
      // Events were pruned before they were delivered; subscribers resync via catch-up.
      this.watermark = result.firstRetainedSeq - 1;
      return;
    }
    for (const envelope of result) {
      this.watermark = envelope.seq;
      for (const subscriber of [...this.subscribers]) {
        if (!audienceAllows(subscriber.filter, envelope)) continue;
        try {
          subscriber.listener(envelope);
        } catch {
          // A failing listener must not stop delivery to the others.
        }
      }
    }
  }
}

function normalizeAppend(input: EventAppend): NormalizedAppend {
  if (!(EVENT_TYPES as readonly string[]).includes(input.type))
    throw new HomectlError(2, `Unknown event type: ${String(input.type)}`);
  if (
    typeof input.subject !== "string" ||
    input.subject.length === 0 ||
    input.subject.length > MAX_SUBJECT_LENGTH
  )
    throw new HomectlError(2, "Event subject must be 1-256 characters");
  if (
    !Array.isArray(input.audience) ||
    input.audience.some(
      (client) => typeof client !== "string" || !CLIENT_ID_PATTERN.test(client),
    )
  )
    throw new HomectlError(2, "Event audience must list client ids");
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input.data);
  } catch {
    encoded = undefined;
  }
  if (encoded === undefined)
    throw new HomectlError(2, "Event data must be JSON-serialisable");
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_DATA_BYTES)
    throw new HomectlError(2, "Event data exceeds 64 KiB");
  return {
    type: input.type,
    subject: input.subject,
    audience: [...new Set(input.audience)],
    data: input.data,
  };
}
