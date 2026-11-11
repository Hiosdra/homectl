import { describe, expect, test } from "bun:test";
import {
  AttentionWatch,
  WARN_BEFORE_MS,
  type WatchedOperation,
} from "../src/web/attention";

const NOW = Date.parse("2026-11-11T12:00:00Z");

function op(
  overrides: Partial<WatchedOperation> & { operationId: string },
): WatchedOperation {
  return {
    host: "lab-printer",
    state: "pending",
    needsApproval: true,
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    argv: ["systemctl", "restart", "klipper"],
    ...overrides,
  };
}

function watch(now: { value: number }) {
  const sent: string[] = [];
  const watcher = new AttentionWatch({
    send: (notice) => sent.push(notice.title),
    now: () => now.value,
  });
  return { watcher, sent };
}

describe("attention notifications", () => {
  test("old requests at startup are recorded, not announced", () => {
    const now = { value: NOW };
    const { watcher, sent } = watch(now);
    watcher.check([op({ operationId: "a" })]);
    expect(sent).toEqual([]);
  });

  test("a request that starts waiting for approval is announced once", () => {
    const now = { value: NOW };
    const { watcher, sent } = watch(now);
    watcher.check([]);
    watcher.check([op({ operationId: "b" })]);
    watcher.check([op({ operationId: "b" })]);
    expect(sent).toEqual(["Request waiting for approval"]);
  });

  test("a ready request is announced once when it is about to expire", () => {
    const now = { value: NOW };
    const { watcher, sent } = watch(now);
    const ready = { state: "approved", needsApproval: false };
    watcher.check([op({ operationId: "c", ...ready })]);
    now.value = NOW + 60 * 60_000 - WARN_BEFORE_MS + 1_000;
    watcher.check([
      op({
        operationId: "c",
        ...ready,
        expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
      }),
    ]);
    watcher.check([
      op({
        operationId: "c",
        ...ready,
        expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
      }),
    ]);
    expect(sent).toEqual(["Request expires soon"]);
  });

  test("a request far from expiry is not announced", () => {
    const now = { value: NOW };
    const { watcher, sent } = watch(now);
    watcher.check([]);
    watcher.check([
      op({ operationId: "d", state: "approved", needsApproval: false }),
    ]);
    expect(sent).toEqual([]);
  });

  test("forgotten operations are dropped from memory", () => {
    const now = { value: NOW };
    const { watcher, sent } = watch(now);
    watcher.check([]);
    watcher.check([op({ operationId: "e" })]);
    watcher.check([]);
    watcher.check([op({ operationId: "e" })]);
    expect(sent).toEqual([
      "Request waiting for approval",
      "Request waiting for approval",
    ]);
  });
});
