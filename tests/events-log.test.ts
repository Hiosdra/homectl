import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "../src/core/contracts";
import type { EventAppend } from "../src/events";
import { EventLog, isGap, MAX_EVENT_DATA_BYTES } from "../src/events";

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
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(label: string) {
  const { directory, cleanup } = await tempDir(label);
  cleanups.push(cleanup);
  return directory;
}

function seqs(events: EventEnvelope[]): number[] {
  return events.map((event) => event.seq);
}

describe("EventLog sequence", () => {
  test("seq is strictly +1 and survives a restart", async () => {
    const directory = await fixture("restart");
    const first = new EventLog({ directory, origin: "dev-a", now: () => 1 });
    expect((await first.append(appendInput("a"))).seq).toBe(1);
    expect((await first.append(appendInput("b"))).seq).toBe(2);
    expect((await first.append(appendInput("c"))).seq).toBe(3);

    const restarted = new EventLog({ directory, origin: "dev-a" });
    const next = await restarted.append(appendInput("d"));
    expect(next.seq).toBe(4);
    expect(next.id).toBe("dev-a:4");
    expect(next.origin).toBe("dev-a");
    expect(seqs((await restarted.since(0)) as EventEnvelope[])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("concurrent appends from two instances never reuse a seq", async () => {
    const directory = await fixture("concurrent");
    const a = new EventLog({ directory, origin: "dev-a" });
    const b = new EventLog({ directory, origin: "dev-a" });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => a.append(appendInput(`a${i}`))),
      ...Array.from({ length: 10 }, (_, i) => b.append(appendInput(`b${i}`))),
    ]);
    const sorted = results.map((event) => event.seq).sort((x, y) => x - y);
    expect(sorted).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  }, 30_000);

  test("a torn tail from an interrupted append is repaired", async () => {
    const directory = await fixture("torn");
    const log = new EventLog({ directory, origin: "dev-a" });
    await log.append(appendInput("a"));
    await log.append(appendInput("b"));
    const segment = (await readdir(directory)).find((name) =>
      name.startsWith("segment-"),
    );
    if (!segment) throw new Error("no segment written");
    await appendFile(join(directory, segment), '{"id":"dev-a:3","seq"');

    const next = await new EventLog({ directory, origin: "dev-a" }).append(
      appendInput("c"),
    );
    expect(next.seq).toBe(3);
    expect(seqs((await log.since(0)) as EventEnvelope[])).toEqual([1, 2, 3]);
  }, 30_000);
});

describe("EventLog retention", () => {
  test("keeps the newest maxRetained events and reports a gap", async () => {
    const directory = await fixture("retention");
    const log = new EventLog({ directory, origin: "dev-a", maxRetained: 5 });
    for (let i = 1; i <= 12; i++) await log.append(appendInput(`s${i}`));

    const state = await log.state();
    expect(state.head).toBe(12);
    expect(state.firstRetainedSeq).toBe(8);

    const gap = await log.since(3);
    expect(isGap(gap)).toBe(true);
    expect(gap).toEqual({ gap: true, firstRetainedSeq: 8 });

    const caught = await log.since(7);
    expect(isGap(caught)).toBe(false);
    expect(seqs(caught as EventEnvelope[])).toEqual([8, 9, 10, 11, 12]);
  }, 30_000);

  test("a cursor exactly at the retention edge is not a gap", async () => {
    const directory = await fixture("edge");
    const log = new EventLog({ directory, origin: "dev-a", maxRetained: 3 });
    for (let i = 1; i <= 6; i++) await log.append(appendInput(`s${i}`));
    const result = await log.since(3);
    expect(seqs(result as EventEnvelope[])).toEqual([4, 5, 6]);
  }, 30_000);
});

describe("EventLog audience filter", () => {
  test("a client sees only events that list it; owner sees all", async () => {
    const directory = await fixture("audience");
    const log = new EventLog({ directory, origin: "dev-a" });
    await log.append(appendInput("for-phone", ["phone"]));
    await log.append(appendInput("for-laptop", ["laptop"]));
    await log.append(appendInput("owner-only", []));

    const phone = await log.since(0, { client: "phone" });
    expect(seqs(phone as EventEnvelope[])).toEqual([1]);
    const owner = await log.since(0, { owner: true });
    expect(seqs(owner as EventEnvelope[])).toEqual([1, 2, 3]);
  });

  test("live subscribers honour the same filter", async () => {
    const directory = await fixture("live-audience");
    const log = new EventLog({ directory, origin: "dev-a" });
    const seen: number[] = [];
    const stop = log.subscribe((event) => seen.push(event.seq), {
      client: "phone",
    });
    await log.append(appendInput("other", ["laptop"]));
    await log.append(appendInput("mine", ["phone"]));
    expect(seen).toEqual([2]);
    stop();
  });
});

describe("EventLog validation and live delivery", () => {
  test("rejects unknown types, bad audiences and oversized data", async () => {
    const directory = await fixture("validate");
    const log = new EventLog({ directory, origin: "dev-a" });
    await expect(
      log.append({
        type: "not.a.type" as never,
        subject: "x",
        audience: [],
        data: {},
      }),
    ).rejects.toThrow();
    await expect(
      log.append({ ...appendInput("x"), audience: ["Bad Id"] }),
    ).rejects.toThrow();
    const big = "x".repeat(MAX_EVENT_DATA_BYTES + 1);
    await expect(log.append(appendInput("big", [], { big }))).rejects.toThrow();
    expect((await log.state()).head).toBe(0);
  });

  test("subscribers receive appends made by this instance", async () => {
    const directory = await fixture("subscribe");
    const log = new EventLog({ directory, origin: "dev-a" });
    const seen: number[] = [];
    const stop = log.subscribe((event) => seen.push(event.seq));
    await log.append(appendInput("one"));
    await log.append(appendInput("two"));
    stop();
    await log.append(appendInput("three"));
    expect(seen).toEqual([1, 2]);
  });

  test("subscribers see appends made by another process instance", async () => {
    const directory = await fixture("watch");
    const reader = new EventLog({ directory, origin: "dev-a", watchMs: 20 });
    const writer = new EventLog({ directory, origin: "dev-a" });
    const seen: number[] = [];
    const stop = reader.subscribe((event) => seen.push(event.seq));
    await Bun.sleep(40);
    await writer.append(appendInput("from-other-instance"));
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([1]);
    stop();
  });
});
