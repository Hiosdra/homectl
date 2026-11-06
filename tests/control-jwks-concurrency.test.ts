import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { JwksSource } from "../src/control/oidc";

// Synthetic issuer: a delayed JWKS fetch, so two lookups overlap in time.
// Nothing contacts a real identity provider.
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = {
  ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
  kid: "synthetic-key-1",
  use: "sig",
  alg: "ES256",
};

function delayedFetcher(delayMs: number) {
  const calls = { count: 0 };
  const fetcher = async () => {
    calls.count += 1;
    await Bun.sleep(delayMs);
    return new Response(JSON.stringify({ keys: [jwk] }));
  };
  return { fetcher, calls };
}

describe("JWKS lookups during a refresh", () => {
  test("two concurrent lookups for a new key both get it, from one shared fetch", async () => {
    const { fetcher, calls } = delayedFetcher(150);
    const source = new JwksSource(
      "https://idp.example.test",
      "https://idp.example.test/jwks.json",
      fetcher as never,
      Date.now,
    );
    const [first, second] = await Promise.all([
      source.keyFor("synthetic-key-1", "ES256"),
      source.keyFor("synthetic-key-1", "ES256"),
    ]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(calls.count).toBe(1);
  });

  test("throttling still applies between completed attempts: an unknown key does not refetch at once", async () => {
    const { fetcher, calls } = delayedFetcher(5);
    const source = new JwksSource(
      "https://idp.example.test",
      "https://idp.example.test/jwks.json",
      fetcher as never,
      Date.now,
    );
    await source.keyFor("synthetic-key-1", "ES256");
    expect(calls.count).toBe(1);
    expect(await source.keyFor("unknown-kid", "ES256")).toBeUndefined();
    expect(calls.count).toBe(1);
  });
});
