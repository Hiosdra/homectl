import type { EventEnvelope } from "../core/contracts";
import { HomectlError } from "../types";

export const MAX_BUFFERED_PER_ORIGIN = 1000;
const DEFAULT_STALE_MS = 60_000;

export interface EventMirrorOptions {
  now?: () => number;
  staleMs?: number;
  maxBuffered?: number;
  // Called once per event, in seq order per origin.
  onApply?: (envelope: EventEnvelope) => void;
}

export interface MirrorGap {
  origin: string;
  fromSeq: number;
}

export type IngestResult = "applied" | "duplicate" | { gap: MirrorGap };

export interface OriginState {
  lastSeq: number;
  lastSeenAt: number | null;
  stale: boolean;
}

interface OriginSlot {
  lastSeq: number;
  lastSeenAt: number | null;
  buffer: Map<number, EventEnvelope>;
}

// Consumer side: mirrors one or more origins' event streams. Events are applied
// in seq order. A future event is buffered and reported as a gap so the
// consumer fetches catch-up from `fromSeq`.
export class EventMirror {
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly maxBuffered: number;
  private readonly onApply: ((envelope: EventEnvelope) => void) | undefined;
  private readonly slots = new Map<string, OriginSlot>();

  constructor(options: EventMirrorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.maxBuffered = options.maxBuffered ?? MAX_BUFFERED_PER_ORIGIN;
    this.onApply = options.onApply;
  }

  ingest(envelope: EventEnvelope): IngestResult {
    assertEnvelope(envelope);
    const slot = this.slotFor(envelope.origin);
    slot.lastSeenAt = this.now();
    if (envelope.seq <= slot.lastSeq) return "duplicate";
    if (envelope.seq === slot.lastSeq + 1) {
      this.apply(slot, envelope);
      this.drain(slot);
      return "applied";
    }
    if (!slot.buffer.has(envelope.seq) && slot.buffer.size < this.maxBuffered)
      slot.buffer.set(envelope.seq, envelope);
    return { gap: { origin: envelope.origin, fromSeq: slot.lastSeq + 1 } };
  }

  stateOf(origin: string): OriginState {
    const slot = this.slots.get(origin);
    const lastSeenAt = slot?.lastSeenAt ?? null;
    return {
      lastSeq: slot?.lastSeq ?? 0,
      lastSeenAt,
      stale: lastSeenAt === null || this.now() - lastSeenAt > this.staleMs,
    };
  }

  private slotFor(origin: string): OriginSlot {
    let slot = this.slots.get(origin);
    if (!slot) {
      slot = { lastSeq: 0, lastSeenAt: null, buffer: new Map() };
      this.slots.set(origin, slot);
    }
    return slot;
  }

  private apply(slot: OriginSlot, envelope: EventEnvelope): void {
    slot.lastSeq = envelope.seq;
    slot.buffer.delete(envelope.seq);
    this.onApply?.(envelope);
  }

  private drain(slot: OriginSlot): void {
    let next = slot.buffer.get(slot.lastSeq + 1);
    while (next) {
      this.apply(slot, next);
      next = slot.buffer.get(slot.lastSeq + 1);
    }
  }
}

function assertEnvelope(envelope: EventEnvelope): void {
  if (
    typeof envelope.origin !== "string" ||
    envelope.origin.length === 0 ||
    !Number.isSafeInteger(envelope.seq) ||
    envelope.seq < 1
  )
    throw new HomectlError(2, "Event envelope needs an origin and a seq >= 1");
}
