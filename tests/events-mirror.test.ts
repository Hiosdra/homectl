import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../src/core/contracts";
import { EventMirror } from "../src/events";

function envelope(origin: string, seq: number): EventEnvelope {
  return {
    id: `${origin}:${seq}`,
    origin,
    seq,
    at: 0,
    type: "task.updated",
    subject: `task-${seq}`,
    audience: [],
    data: {},
  };
}

describe("EventMirror", () => {
  test("applies in order and drops duplicates", () => {
    const applied: number[] = [];
    const mirror = new EventMirror({ onApply: (e) => applied.push(e.seq) });
    expect(mirror.ingest(envelope("dev-a", 1))).toBe("applied");
    expect(mirror.ingest(envelope("dev-a", 2))).toBe("applied");
    expect(mirror.ingest(envelope("dev-a", 2))).toBe("duplicate");
    expect(mirror.ingest(envelope("dev-a", 1))).toBe("duplicate");
    expect(applied).toEqual([1, 2]);
    expect(mirror.stateOf("dev-a").lastSeq).toBe(2);
  });

  test("buffers out-of-order events and applies them when the gap fills", () => {
    const applied: number[] = [];
    const mirror = new EventMirror({ onApply: (e) => applied.push(e.seq) });
    mirror.ingest(envelope("dev-a", 1));
    expect(mirror.ingest(envelope("dev-a", 4))).toEqual({
      gap: { origin: "dev-a", fromSeq: 2 },
    });
    expect(mirror.ingest(envelope("dev-a", 3))).toEqual({
      gap: { origin: "dev-a", fromSeq: 2 },
    });
    expect(applied).toEqual([1]);
    expect(mirror.ingest(envelope("dev-a", 2))).toBe("applied");
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(mirror.stateOf("dev-a").lastSeq).toBe(4);
  });

  test("reports a gap with the first missing seq and bounds the buffer", () => {
    const mirror = new EventMirror({ maxBuffered: 2 });
    expect(mirror.ingest(envelope("dev-a", 3))).toEqual({
      gap: { origin: "dev-a", fromSeq: 1 },
    });
    mirror.ingest(envelope("dev-a", 4));
    mirror.ingest(envelope("dev-a", 5));
    // Buffer is full: seq 5 was dropped, catch-up must supply it later.
    expect(mirror.ingest(envelope("dev-a", 1))).toBe("applied");
    expect(mirror.ingest(envelope("dev-a", 2))).toBe("applied");
    expect(mirror.stateOf("dev-a").lastSeq).toBe(4);
    expect(mirror.ingest(envelope("dev-a", 5))).toBe("applied");
  });

  test("origins are tracked independently", () => {
    const mirror = new EventMirror();
    expect(mirror.ingest(envelope("dev-a", 1))).toBe("applied");
    expect(mirror.ingest(envelope("dev-b", 1))).toBe("applied");
    expect(mirror.stateOf("dev-a").lastSeq).toBe(1);
    expect(mirror.stateOf("dev-b").lastSeq).toBe(1);
  });

  test("stateOf marks an origin stale after staleMs of silence", () => {
    let now = 1_000;
    const mirror = new EventMirror({ now: () => now, staleMs: 500 });
    expect(mirror.stateOf("dev-a")).toEqual({
      lastSeq: 0,
      lastSeenAt: null,
      stale: true,
    });
    mirror.ingest(envelope("dev-a", 1));
    expect(mirror.stateOf("dev-a")).toEqual({
      lastSeq: 1,
      lastSeenAt: 1_000,
      stale: false,
    });
    now = 1_500;
    expect(mirror.stateOf("dev-a").stale).toBe(false);
    now = 1_501;
    expect(mirror.stateOf("dev-a").stale).toBe(true);
  });
});
