// The release check shared by the panel and the broker (src/update-check.ts).
import { describe, expect, test } from "bun:test";
import * as shared from "../src/update-check";
import * as panel from "../src/web/update-status";

describe("version comparison", () => {
  test("a higher patch, minor or major release is newer", () => {
    expect(shared.isNewer("0.3.1", "0.3.0")).toBe(true);
    expect(shared.isNewer("0.4.0", "0.3.9")).toBe(true);
    expect(shared.isNewer("v1.0.0", "0.9.9")).toBe(true);
  });

  test("the same or an older release is not newer", () => {
    expect(shared.isNewer("0.3.0", "0.3.0")).toBe(false);
    expect(shared.isNewer("0.2.9", "0.3.0")).toBe(false);
  });

  test("an unparseable version is never newer", () => {
    expect(shared.isNewer("latest", "0.3.0")).toBe(false);
    expect(shared.isNewer("0.4.0", "unknown")).toBe(false);
  });
});

describe("re-exports from the panel module", () => {
  test("web imports keep the same functions and class", () => {
    expect(panel.isNewer).toBe(shared.isNewer);
    expect(panel.parseVersion).toBe(shared.parseVersion);
    expect(panel.RELEASE_API).toBe(shared.RELEASE_API);
    expect(panel.UpdateChecker).toBe(shared.UpdateChecker);
  });
});

describe("UpdateChecker", () => {
  const release = (tag: string) =>
    new Response(
      JSON.stringify({
        tag_name: tag,
        html_url: "https://github.com/Hiosdra/homectl/releases/tag/" + tag,
      }),
      { status: 200 },
    );

  test("reports an available release and caches the answer for the TTL", async () => {
    let calls = 0;
    let now = 1_000;
    const checker = new shared.UpdateChecker({
      current: "0.3.0",
      now: () => now,
      fetch: async () => {
        calls++;
        return release("v0.3.1");
      },
    });
    const first = await checker.status();
    expect(first).toMatchObject({
      current: "0.3.0",
      latest: "0.3.1",
      available: true,
      checkedAt: 1_000,
    });
    now += 1_000;
    await checker.status();
    expect(calls).toBe(1);
  });

  test("a failed check is reported, not thrown", async () => {
    const checker = new shared.UpdateChecker({
      current: "0.3.0",
      fetch: async () => new Response("nope", { status: 503 }),
    });
    expect(await checker.status()).toEqual({
      current: "0.3.0",
      available: false,
      error: "release check returned 503",
    });
  });
});
