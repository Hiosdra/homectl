// `home-ctl panel` (audit 3.3): the launch token is traded for a one-time code,
// so no token ever appears in the address the browser opens.
import { expect, test } from "bun:test";
import { HomectlError } from "../src/types";
import { LaunchCodes, requestLaunchCode } from "../src/web/launch-code";

test("a launch code works once, and only within its time", () => {
  let now = 1_000;
  const codes = new LaunchCodes(() => now, 60_000);
  const { code } = codes.issue();
  expect(code.length).toBeGreaterThan(20);
  expect(codes.redeem(code)).toBe(true);
  // Spent on first use: a second visit (or a copied link) gets nothing.
  expect(codes.redeem(code)).toBe(false);
  expect(codes.redeem(null)).toBe(false);
  expect(codes.redeem("guessed")).toBe(false);

  const late = codes.issue().code;
  now += 60_000;
  expect(codes.redeem(late)).toBe(false);
});

test("the CLI trades the token for a code over a POST from the panel origin", async () => {
  const token = "launch-token-stays-local";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/api/launch" || req.method !== "POST")
        return new Response("no", { status: 404 });
      const origin = `http://127.0.0.1:${server.port}`;
      const body = (await req.json()) as { token?: string };
      if (req.headers.get("origin") !== origin)
        return Response.json({ error: "origin" }, { status: 403 });
      if (body.token !== token)
        return Response.json({ error: "token" }, { status: 403 });
      return Response.json({ code: "one-time-code", expiresInSeconds: 120 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    expect(await requestLaunchCode({ url, token })).toBe("one-time-code");
    const error = await requestLaunchCode({ url, token: "wrong" }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(HomectlError);
    expect((error as HomectlError).message).toContain("home-ctl panel again");
  } finally {
    server.stop(true);
  }
});
