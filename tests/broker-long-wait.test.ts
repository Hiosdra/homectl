import { describe, expect, test } from "bun:test";
import {
  callWithWait,
  type BrokerCall,
  UNREACHABLE_MESSAGE,
  WAIT_CHUNK_MS,
  type WaitClock,
  waitInChunks,
} from "../src/broker/long-wait";
import { HomectlError } from "../src/types";

// A fake clock: sleep() just moves time forward, so nothing really waits.
function fakeClock(): WaitClock & { t: number } {
  const clock = {
    t: 0,
    now() {
      return clock.t;
    },
    async sleep(ms: number) {
      clock.t += ms;
    },
  };
  return clock;
}

const unreachable = () => new HomectlError(5, UNREACHABLE_MESSAGE);

interface Step {
  path: string;
  body: Record<string, unknown>;
  at: number;
}

// Replies in order. A function reply throws, so a test can drop a request.
function scripted(
  clock: { t: number },
  replies: (Record<string, unknown> | "drop")[],
) {
  const steps: Step[] = [];
  let i = 0;
  const call: BrokerCall = async <T>(
    path: string,
    body: Record<string, unknown>,
  ) => {
    steps.push({ path, body, at: clock.t });
    const reply = replies[i];
    i += 1;
    if (reply === undefined) throw new Error("no scripted reply");
    if (reply === "drop") throw unreachable();
    // "took" is how long the broker held the request before it answered.
    clock.t += Number(reply.took ?? 0);
    return reply as T;
  };
  return { call, steps };
}

describe("long waits are split into chunks under the broker idle timeout", () => {
  test("a 600 s wait never asks one request for more than one chunk", async () => {
    const clock = fakeClock();
    const waiting = { id: "op_1", state: "awaiting-approval" };
    const { call, steps } = scripted(clock, [
      ...Array.from({ length: 5 }, () => ({ ...waiting, took: WAIT_CHUNK_MS })),
    ]);
    // Every reply reports the op still waiting, so the wait runs out.
    const view = await waitInChunks(call, "op_1", 600_000, undefined, clock);
    expect(view.state).toBe("awaiting-approval");
    for (const step of steps) {
      expect(step.path).toBe("/v1/wait");
      expect(Number(step.body.timeoutMs)).toBeLessThanOrEqual(WAIT_CHUNK_MS);
    }
    expect(steps.length).toBeGreaterThan(1);
  });

  test("a wait that is finished in a later chunk returns that state", async () => {
    const clock = fakeClock();
    const { call, steps } = scripted(clock, [
      { id: "op_2", state: "awaiting-approval", took: WAIT_CHUNK_MS },
      { id: "op_2", state: "succeeded", result: { exitCode: 0 }, took: 1 },
    ]);
    const view = await waitInChunks(call, "op_2", 600_000, undefined, clock);
    expect(view.state).toBe("succeeded");
    expect(steps).toHaveLength(2);
  });

  test("a dropped request is retried and the wait goes on", async () => {
    const clock = fakeClock();
    const { call } = scripted(clock, [
      "drop",
      { id: "op_3", state: "succeeded", result: { exitCode: 0 }, took: 1 },
    ]);
    const view = await waitInChunks(call, "op_3", 600_000, undefined, clock);
    expect(view.state).toBe("succeeded");
  });

  test("after repeated drops the error names the operation, not unreachable", async () => {
    const clock = fakeClock();
    const { call } = scripted(clock, ["drop", "drop", "drop"]);
    const error = await waitInChunks(call, "op_4", 600_000, undefined, clock)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HomectlError);
    const message = (error as HomectlError).message;
    expect(message).toContain("op_4");
    expect(message).not.toContain("not reachable");
  });

  test("a wait of 0 still asks once and returns the state", async () => {
    const clock = fakeClock();
    const { call, steps } = scripted(clock, [{ id: "op_5", state: "running" }]);
    const view = await waitInChunks(call, "op_5", 0, undefined, clock);
    expect(view.state).toBe("running");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.body.timeoutMs).toBe(0);
  });
});

describe("exec with a long --wait", () => {
  test("600 s becomes one exec request for one chunk, then polling", async () => {
    const clock = fakeClock();
    const { call, steps } = scripted(clock, [
      { id: "op_6", state: "awaiting-approval", took: WAIT_CHUNK_MS },
      { id: "op_6", state: "succeeded", result: { exitCode: 0 }, took: 1 },
    ]);
    const view = await callWithWait(
      call,
      "/v1/exec",
      { host: "lab", argv: ["uptime"], waitMs: 600_000 },
      clock,
    );
    expect(view.state).toBe("succeeded");
    expect(steps[0]?.path).toBe("/v1/exec");
    expect(steps[0]?.body.waitMs).toBe(WAIT_CHUNK_MS);
    expect(steps[1]?.path).toBe("/v1/wait");
    expect(Number(steps[1]?.body.timeoutMs)).toBeLessThanOrEqual(WAIT_CHUNK_MS);
  });

  test("a short wait stays a single exec request", async () => {
    const clock = fakeClock();
    const { call, steps } = scripted(clock, [
      { id: "op_7", state: "succeeded", result: { exitCode: 0 }, took: 1 },
    ]);
    const view = await callWithWait(
      call,
      "/v1/exec",
      { host: "lab", argv: ["uptime"], waitMs: 30_000 },
      clock,
    );
    expect(view.state).toBe("succeeded");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.body.waitMs).toBe(30_000);
  });

  test("a denied exec is returned at once, without polling", async () => {
    const clock = fakeClock();
    const { call, steps } = scripted(clock, [{ id: "op_8", state: "denied" }]);
    const view = await callWithWait(
      call,
      "/v1/exec",
      { host: "lab", argv: ["rm"], waitMs: 600_000 },
      clock,
    );
    expect(view.state).toBe("denied");
    expect(steps).toHaveLength(1);
  });

  test("the timeout keeps the operation in view, still waiting for approval", async () => {
    const clock = fakeClock();
    const waiting = { id: "op_9", state: "awaiting-approval" };
    const { call } = scripted(clock, [
      ...Array.from({ length: 5 }, () => ({ ...waiting, took: WAIT_CHUNK_MS })),
    ]);
    const view = await callWithWait(
      call,
      "/v1/exec",
      { host: "lab", argv: ["uptime"], waitMs: 600_000 },
      clock,
    );
    expect(view).toMatchObject({ id: "op_9", state: "awaiting-approval" });
  });
});
