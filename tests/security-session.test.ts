// Owner session fixation, logout and expiry (homelab #21 §10, session fixation).
// A token planted or presented before owner login must never become a session,
// login always mints a fresh token, logout ends the token, and an expired token
// is refused on owner routes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Broker } from "../src/broker/engine";
import {
  FileVerifier,
  OWNER_SESSION_MS,
  OwnerSessions,
} from "../src/broker/owner";
import { handler } from "../src/broker/server";

const PANEL = "http://127.0.0.1:7448";
const PASSWORD = "correct horse battery";
// Shaped like a real owner token (hco_ + 43 base64url characters), never minted.
const PLANTED = `hco_${"A".repeat(43)}`;
const START = 1_800_000_000_000;

let dir: string;
let clock: number;
let verifier: FileVerifier;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-session-fixation-"));
  clock = START;
  verifier = new FileVerifier(join(dir, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  });
  await verifier.set(PASSWORD);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const now = () => clock;

describe("owner sessions: fixation and lifetime", () => {
  test("a token presented before login is not a session, before or after login", async () => {
    const sessions = new OwnerSessions(verifier, now);
    expect(sessions.resolve(PLANTED)).toBeUndefined();
    const session = await sessions.login(PASSWORD, "panel");
    expect(session.token).not.toBe(PLANTED);
    expect(sessions.resolve(PLANTED)).toBeUndefined();
    expect(sessions.resolve(session.token)?.surface).toBe("panel");
  });

  test("each login mints a fresh random token", async () => {
    const sessions = new OwnerSessions(verifier, now);
    const first = await sessions.login(PASSWORD, "cli");
    const second = await sessions.login(PASSWORD, "cli");
    expect(first.token).toMatch(/^hco_[A-Za-z0-9_-]{43}$/);
    expect(second.token).not.toBe(first.token);
  });

  test("a wrong password mints nothing", async () => {
    const sessions = new OwnerSessions(verifier, now);
    await expect(sessions.login("wrong password", "cli")).rejects.toThrow(
      "Wrong owner password",
    );
    expect(sessions.resolve(PLANTED)).toBeUndefined();
  });

  test("logout invalidates the token at once; logging out an unknown token is harmless", async () => {
    const sessions = new OwnerSessions(verifier, now);
    const session = await sessions.login(PASSWORD, "cli");
    expect(sessions.resolve(session.token)).toBeDefined();
    sessions.logout(session.token);
    expect(sessions.resolve(session.token)).toBeUndefined();
    expect(() => sessions.logout(PLANTED)).not.toThrow();
    expect(() => sessions.logout(undefined)).not.toThrow();
  });

  test("an expired token is refused; one millisecond before expiry it still works", async () => {
    const sessions = new OwnerSessions(verifier, now);
    const session = await sessions.login(PASSWORD, "cli");
    clock = START + OWNER_SESSION_MS - 1;
    expect(sessions.resolve(session.token)).toBeDefined();
    clock = START + OWNER_SESSION_MS;
    expect(sessions.resolve(session.token)).toBeUndefined();
  });
});

describe("owner routes: fixation over HTTP", () => {
  // The broker is not exercised here; owner routes only need pending().
  const broker = { pending: async () => [] } as unknown as Broker;
  const httpHandler = () =>
    handler({
      broker,
      clients: { authenticate: async () => null },
      owner: new OwnerSessions(verifier, now),
      listen: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
      allowedOrigins: [PANEL],
    });
  const post = (
    fetch: (req: Request) => Promise<Response>,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(
      new Request(`http://broker${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const tokenOf = (res: Response) =>
    (res.headers.get("set-cookie") ?? "").split(";")[0]?.split("=")[1] ?? "";

  test("a cookie planted before login is refused, and login ignores it", async () => {
    const fetch = httpHandler();
    const planted = { cookie: `hc_owner=${PLANTED}`, origin: PANEL };
    expect((await post(fetch, "/v1/owner/pending", {}, planted)).status).toBe(
      403,
    );

    const login = await post(
      fetch,
      "/v1/owner/login",
      { password: PASSWORD },
      planted,
    );
    expect(login.status).toBe(200);
    const issued = tokenOf(login);
    expect(issued).toMatch(/^hco_/);
    expect(issued).not.toBe(PLANTED);

    // The planted value still does not authenticate after login.
    expect((await post(fetch, "/v1/owner/pending", {}, planted)).status).toBe(
      403,
    );
    const fresh = await post(
      fetch,
      "/v1/owner/pending",
      {},
      { cookie: `hc_owner=${issued}`, origin: PANEL },
    );
    expect(fresh.status).toBe(200);
  });

  test("a planted Owner bearer is refused", async () => {
    const fetch = httpHandler();
    const res = await post(
      fetch,
      "/v1/owner/pending",
      {},
      { authorization: `Owner ${PLANTED}` },
    );
    expect(res.status).toBe(403);
  });

  test("logout ends the session on both the cookie and the bearer", async () => {
    const fetch = httpHandler();
    const login = await post(
      fetch,
      "/v1/owner/login",
      { password: PASSWORD },
      { origin: PANEL },
    );
    const token = tokenOf(login);
    const cookie = `hc_owner=${token}`;
    expect(
      (await post(fetch, "/v1/owner/pending", {}, { cookie, origin: PANEL }))
        .status,
    ).toBe(200);
    expect(
      (await post(fetch, "/v1/owner/logout", {}, { cookie, origin: PANEL }))
        .status,
    ).toBe(200);
    expect(
      (await post(fetch, "/v1/owner/pending", {}, { cookie, origin: PANEL }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          fetch,
          "/v1/owner/pending",
          {},
          { authorization: `Owner ${token}` },
        )
      ).status,
    ).toBe(403);
  });

  test("an expired session is refused on owner routes", async () => {
    const fetch = httpHandler();
    const login = await post(
      fetch,
      "/v1/owner/login",
      { password: PASSWORD },
      { origin: PANEL },
    );
    const cookie = `hc_owner=${tokenOf(login)}`;
    clock = START + OWNER_SESSION_MS;
    expect(
      (await post(fetch, "/v1/owner/pending", {}, { cookie, origin: PANEL }))
        .status,
    ).toBe(403);
  });
});
