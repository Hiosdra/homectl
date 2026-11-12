import { describe, expect, test } from "bun:test";
import {
  handleUpdateRoute,
  isNewer,
  UpdateChecker,
} from "../src/web/update-status";

function releaseFetch(tag: string | undefined, status = 200) {
  const calls = { count: 0 };
  const fetcher = async () => {
    calls.count += 1;
    if (status !== 200) return new Response("nope", { status });
    return new Response(
      JSON.stringify({
        tag_name: tag,
        html_url: `https://github.com/Hiosdra/homectl/releases/tag/${tag}`,
      }),
      { status: 200 },
    );
  };
  return { fetcher, calls };
}

describe("version comparison", () => {
  test("a higher release is newer, equal or lower is not", () => {
    expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("v0.2.10", "0.2.9")).toBe(true);
    expect(isNewer("v0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("v0.1.9", "0.2.0")).toBe(false);
  });

  test("unparseable versions are never reported as newer", () => {
    expect(isNewer("latest", "0.2.0")).toBe(false);
    expect(isNewer("v1.0.0", "dev")).toBe(false);
  });
});

describe("update checker", () => {
  test("reports an available release with its page", async () => {
    const { fetcher } = releaseFetch("v0.3.0");
    const checker = new UpdateChecker({
      current: "0.2.0",
      fetch: fetcher,
      now: () => 0,
    });
    const status = await checker.status();
    expect(status.available).toBe(true);
    expect(status.latest).toBe("0.3.0");
    expect(status.url).toContain("/releases/tag/v0.3.0");
  });

  test("the answer is cached for a day", async () => {
    const { fetcher, calls } = releaseFetch("v0.3.0");
    let now = 0;
    const checker = new UpdateChecker({
      current: "0.2.0",
      fetch: fetcher,
      now: () => now,
    });
    await checker.status();
    await checker.status();
    expect(calls.count).toBe(1);
    now += 24 * 60 * 60 * 1000;
    await checker.status();
    expect(calls.count).toBe(2);
  });

  test("a failed check is reported, not thrown", async () => {
    const { fetcher } = releaseFetch(undefined, 503);
    const checker = new UpdateChecker({
      current: "0.2.0",
      fetch: fetcher,
      now: () => 0,
    });
    const status = await checker.status();
    expect(status.available).toBe(false);
    expect(status.error).toContain("503");
  });

  test("an unexpected answer is reported as an error", async () => {
    const { fetcher } = releaseFetch(undefined);
    const checker = new UpdateChecker({
      current: "0.2.0",
      fetch: fetcher,
      now: () => 0,
    });
    expect((await checker.status()).error).toContain("unexpected");
  });

  test("the route answers GET /api/update only", async () => {
    const { fetcher } = releaseFetch("v0.2.0");
    const checker = new UpdateChecker({
      current: "0.2.0",
      fetch: fetcher,
      now: () => 0,
    });
    const url = new URL("http://127.0.0.1:7447/api/update");
    const response = await handleUpdateRoute(new Request(url), url, checker);
    expect(response?.status).toBe(200);
    expect(((await response?.json()) as { available: boolean }).available).toBe(
      false,
    );
    const other = new URL("http://127.0.0.1:7447/api/state");
    expect(
      await handleUpdateRoute(new Request(other), other, checker),
    ).toBeUndefined();
  });
});
