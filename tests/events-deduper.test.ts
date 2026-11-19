import { describe, expect, test } from "bun:test";
import { NotificationDeduper } from "../src/events";

const event = (type: string, subject: string, origin = "dev-a") => ({
  type: type as "approval.requested",
  subject,
  origin,
});

describe("NotificationDeduper", () => {
  test("notifies once per (type, subject) within the window", () => {
    let now = 0;
    const deduper = new NotificationDeduper({ windowMs: 1000, now: () => now });
    expect(deduper.shouldNotify(event("approval.requested", "op-1"))).toBe(
      true,
    );
    now = 999;
    expect(deduper.shouldNotify(event("approval.requested", "op-1"))).toBe(
      false,
    );
    expect(deduper.shouldNotify(event("approval.requested", "op-2"))).toBe(
      true,
    );
    expect(deduper.shouldNotify(event("secret.requested", "op-1"))).toBe(true);
    now = 1000;
    expect(deduper.shouldNotify(event("approval.requested", "op-1"))).toBe(
      true,
    );
  });

  test("never notifies for events this surface caused", () => {
    const deduper = new NotificationDeduper({ surfaceId: "dev-server" });
    expect(
      deduper.shouldNotify(event("approval.requested", "op-1", "dev-server")),
    ).toBe(false);
    expect(
      deduper.shouldNotify(event("approval.requested", "op-1", "dev-phone")),
    ).toBe(true);
  });

  test("defaults to a ten minute window", () => {
    let now = 0;
    const deduper = new NotificationDeduper({ now: () => now });
    expect(deduper.shouldNotify(event("task.updated", "t"))).toBe(true);
    now = 10 * 60_000 - 1;
    expect(deduper.shouldNotify(event("task.updated", "t"))).toBe(false);
    now = 10 * 60_000;
    expect(deduper.shouldNotify(event("task.updated", "t"))).toBe(true);
  });
});
