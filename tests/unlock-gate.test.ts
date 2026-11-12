import { describe, expect, test } from "bun:test";
import { handleUnlockRoute, PanelGate } from "../src/web/unlock-gate";
import {
  fingerprint,
  newServerKeys,
  sealPassword,
} from "../src/web/unlock-seal";

const PASSWORD = "correct-horse-battery-staple-7";
const COOKIE = "A".repeat(43);
const ORIGIN = "http://127.0.0.1:7447";

function harness(overrides: { idleMs?: number } = {}) {
  let clock = 1_000_000;
  const keys = newServerKeys();
  const locks: number[] = [];
  const gate = new PanelGate({
    keys,
    cookie: COOKIE,
    idleMs: overrides.idleMs ?? 2 * 60 * 60 * 1000,
    onLock: () => locks.push(clock),
    now: () => clock,
  });
  const vault = {
    attempts: 0,
    async open(password: string) {
      this.attempts += 1;
      if (password !== PASSWORD) throw new Error("wrong password");
    },
  };
  const attempt = async (password = PASSWORD) => {
    const challenge = gate.issueChallenge();
    const envelope = sealPassword(password, keys.pub, challenge);
    return gate.unlock(envelope, (p) => vault.open(p));
  };
  return {
    gate,
    keys,
    vault,
    locks,
    attempt,
    advance: (ms: number) => {
      clock += ms;
    },
    cookie: `homectl=${COOKIE}`,
  };
}

async function expectRejection(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e as { status?: number; message: string },
  );
  expect(error).toBeDefined();
  expect(error?.status).toBe(status);
}

describe("panel gate: unlock", () => {
  test("the correct vault password unlocks and the cookie then authorizes", async () => {
    const h = harness();
    expect(h.gate.authorize(h.cookie)).toBe(false);
    await h.attempt();
    expect(h.gate.authorize(h.cookie)).toBe(true);
    expect(h.vault.attempts).toBe(1);
  });

  test("a wrong cookie or no cookie is refused even after unlock", async () => {
    const h = harness();
    await h.attempt();
    expect(h.gate.authorize(null)).toBe(false);
    expect(h.gate.authorize("homectl=wrong")).toBe(false);
    expect(h.gate.authorize(h.cookie)).toBe(true);
  });

  test("a challenge works once, so a captured envelope cannot be replayed", async () => {
    const h = harness();
    const challenge = h.gate.issueChallenge();
    const envelope = sealPassword(PASSWORD, h.keys.pub, challenge);
    await h.gate.unlock(envelope, (p) => h.vault.open(p));
    h.gate.lock();
    await expectRejection(
      h.gate.unlock(envelope, (p) => h.vault.open(p)),
      403,
    );
    expect(h.gate.authorize(h.cookie)).toBe(false);
  });

  test("an expired challenge is refused", async () => {
    const h = harness();
    const challenge = h.gate.issueChallenge();
    const envelope = sealPassword(PASSWORD, h.keys.pub, challenge);
    h.advance(5 * 60_000 + 1);
    await expectRejection(
      h.gate.unlock(envelope, (p) => h.vault.open(p)),
      403,
    );
  });

  test("a wrong password is refused without unlocking", async () => {
    const h = harness();
    await expectRejection(h.attempt("wrong"), 403);
    expect(h.gate.authorize(h.cookie)).toBe(false);
  });

  test("five failures lock out for 60 seconds, then the correct password works", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await expectRejection(h.attempt("wrong"), 403);
    await expectRejection(h.attempt(), 429);
    h.advance(59_000);
    await expectRejection(h.attempt(), 429);
    h.advance(2_000);
    await h.attempt();
    expect(h.gate.authorize(h.cookie)).toBe(true);
  });

  test("malformed input is refused and is not counted as a failed attempt", async () => {
    const h = harness();
    h.gate.issueChallenge();
    for (let i = 0; i < 10; i++)
      await expectRejection(
        h.gate.unlock({ eph: 1 }, (p) => h.vault.open(p)),
        400,
      );
    await h.attempt();
    expect(h.gate.authorize(h.cookie)).toBe(true);
  });
});

describe("panel gate: idle and lock", () => {
  test("idle time locks the session and calls onLock once", async () => {
    const h = harness({ idleMs: 60_000 });
    await h.attempt();
    h.advance(59_000);
    expect(h.gate.authorize(h.cookie)).toBe(true);
    h.advance(61_000);
    expect(h.gate.authorize(h.cookie)).toBe(false);
    expect(h.gate.authorize(h.cookie)).toBe(false);
    expect(h.locks).toHaveLength(1);
  });

  test("activity keeps the session open", async () => {
    const h = harness({ idleMs: 60_000 });
    await h.attempt();
    for (let i = 0; i < 10; i++) {
      h.advance(30_000);
      expect(h.gate.authorize(h.cookie)).toBe(true);
    }
  });

  test("an explicit lock calls onLock and refuses the cookie", async () => {
    const h = harness();
    await h.attempt();
    h.gate.lock();
    expect(h.gate.authorize(h.cookie)).toBe(false);
    expect(h.locks).toHaveLength(1);
  });
});

describe("panel gate: routes", () => {
  test("the key endpoint returns the public key and its fingerprint", async () => {
    const h = harness();
    const response = await handleUnlockRoute(
      new Request(`${ORIGIN}/api/unlock/key`),
      new URL(`${ORIGIN}/api/unlock/key`),
      ORIGIN,
      h.gate,
      (p) => h.vault.open(p),
    );
    const body = (await response?.json()) as {
      pub: string;
      fingerprint: string;
    };
    expect(body.fingerprint).toBe(fingerprint(h.keys.pub));
    expect(body.pub).toHaveLength(64);
  });

  test("a cross-origin unlock is refused", async () => {
    const h = harness();
    const response = await handleUnlockRoute(
      new Request(`${ORIGIN}/api/unlock`, {
        method: "POST",
        headers: { Origin: "http://evil.example" },
        body: "{}",
      }),
      new URL(`${ORIGIN}/api/unlock`),
      ORIGIN,
      h.gate,
      (p) => h.vault.open(p),
    );
    expect(response?.status).toBe(403);
  });

  test("a correct unlock sets an HttpOnly, SameSite=Strict cookie", async () => {
    const h = harness();
    const challenge = h.gate.issueChallenge();
    const envelope = sealPassword(PASSWORD, h.keys.pub, challenge);
    const response = await handleUnlockRoute(
      new Request(`${ORIGIN}/api/unlock`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      }),
      new URL(`${ORIGIN}/api/unlock`),
      ORIGIN,
      h.gate,
      (p) => h.vault.open(p),
    );
    expect(response?.status).toBe(200);
    const cookie = response?.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`homectl=${COOKIE}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("other paths are not handled here", async () => {
    const h = harness();
    const response = await handleUnlockRoute(
      new Request(`${ORIGIN}/api/state`),
      new URL(`${ORIGIN}/api/state`),
      ORIGIN,
      h.gate,
      (p) => h.vault.open(p),
    );
    expect(response).toBeUndefined();
  });
});
