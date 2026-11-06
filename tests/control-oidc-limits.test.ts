import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import { parseLifetime } from "../src/control/oidc";
import { HomectlError } from "../src/types";

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const AUDIENCE = "homectl-mcp";
const SUBJECT = "subject-limits-3";
const dirs: string[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Signer {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeSigner(kid: string): Signer {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: {
      ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid,
      use: "sig",
      alg: "RS256",
    },
  };
}

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// Each token gets a unique jti unless the test asks for a fixed one.
let counter = 0;
function mint(signer: Signer, claims: Record<string, unknown>): string {
  const head = b64({ alg: "RS256", kid: signer.kid, typ: "JWT" });
  const body = b64(claims);
  const signature = sign(
    "sha256",
    Buffer.from(`${head}.${body}`),
    signer.privateKey,
  );
  return `${head}.${body}.${signature.toString("base64url")}`;
}

function claimsFor(
  iss: string,
  nowMs: number,
  extra: Record<string, unknown> = {},
) {
  const now = Math.floor(nowMs / 1000);
  counter += 1;
  return {
    iss,
    aud: AUDIENCE,
    sub: SUBJECT,
    jti: `jti-${counter}`,
    iat: now,
    nbf: now,
    exp: now + 300,
    ...extra,
  };
}

async function issuer(keys: Signer[]) {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({ issuer: base, jwks_uri: `${base}/jwks.json` });
      if (url.pathname === "/jwks.json")
        return Response.json({ keys: keys.map((k) => k.jwk) });
      return new Response("not found", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

async function setup(
  extra: { maxLifetimeSeconds?: number; jwksUrl?: string } = {},
) {
  const clock = { now: Date.now() };
  const dir = await mkdtemp(join(tmpdir(), "homectl-oidc-limits-"));
  dirs.push(dir);
  const inventoryPath = join(dir, "inventory.yaml");
  await writeFile(inventoryPath, INVENTORY);
  const control = new ControlPlane({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    stateDirectory: join(dir, "control-plane"),
    clock: () => clock.now,
  });
  await control.init();
  const signer = makeSigner("limits-1");
  const base = await issuer([signer]);
  await control.configureOidc({
    issuer: base,
    audience: AUDIENCE,
    jwksUrl: extra.jwksUrl ?? `${base}/jwks.json`,
    ...(extra.maxLifetimeSeconds !== undefined
      ? { maxLifetimeSeconds: extra.maxLifetimeSeconds }
      : {}),
  });
  await control.createClient({
    id: "oidc-limits",
    name: "OIDC limits",
    scopes: ["status:read"],
    hosts: ["agent-host"],
    issueToken: false,
    oidc: { claim: "sub", value: SUBJECT },
  });
  return { clock, control, signer, base };
}

async function auditOf(control: ControlPlane, event: string) {
  return (await control.auditEntries())
    .map((entry) => entry.event)
    .filter((e) => e.event === event);
}

describe("OIDC audit volume", () => {
  test("a token is audited once, however many requests it makes", async () => {
    const { clock, control, signer, base } = await setup();
    const token = mint(signer, claimsFor(base, clock.now));
    for (let i = 0; i < 5; i += 1)
      expect((await control.authenticate(token))?.id).toBe("oidc-limits");
    expect((await auditOf(control, "auth.oidc")).length).toBe(1);
    // A second, different token is a second audit entry.
    await control.authenticate(mint(signer, claimsFor(base, clock.now)));
    expect((await auditOf(control, "auth.oidc")).length).toBe(2);
  });

  test("identical refusals are written once per minute, with the suppressed count", async () => {
    const { clock, control, signer, base } = await setup();
    const wrongAudience = (): string =>
      mint(signer, claimsFor(base, clock.now, { aud: "someone-else" }));
    await control.authenticate(wrongAudience());
    await control.authenticate(wrongAudience());
    await control.authenticate(wrongAudience());
    const first = await auditOf(control, "auth.rejected");
    expect(
      first.filter((e) => e.reason === "OIDC token refused: oidc-audience")
        .length,
    ).toBe(1);
    clock.now += 61_000;
    await control.authenticate(wrongAudience());
    const later = (await auditOf(control, "auth.rejected")).map(
      (e) => e.reason,
    );
    expect(
      later.some(
        (reason) =>
          reason ===
          "OIDC token refused: oidc-audience; 2 identical suppressed",
      ),
    ).toBe(true);
  });
});

describe("the optional lifetime cap", () => {
  test("parseLifetime accepts 1m to 1h and rejects the rest", () => {
    expect(parseLifetime("15m")).toBe(900);
    expect(parseLifetime("1h")).toBe(3600);
    expect(parseLifetime("900")).toBe(900);
    expect(() => parseLifetime("2h")).toThrow(HomectlError);
    expect(() => parseLifetime("30s")).toThrow(HomectlError);
    expect(() => parseLifetime("soon")).toThrow(HomectlError);
  });

  test("a configured cap refuses longer tokens; the default one-hour cap accepts them", async () => {
    const capped = await setup({ maxLifetimeSeconds: 900 });
    const longToken = (c: {
      clock: { now: number };
      base: string;
      signer: Signer;
    }) =>
      mint(
        c.signer,
        claimsFor(c.base, c.clock.now, {
          exp: Math.floor(c.clock.now / 1000) + 1200,
        }),
      );
    expect(await capped.control.authenticate(longToken(capped))).toBeNull();
    const open = await setup();
    expect((await open.control.authenticate(longToken(open)))?.id).toBe(
      "oidc-limits",
    );
  });

  test("the cap is recorded in the view, and the default is one hour", async () => {
    const { control } = await setup({ maxLifetimeSeconds: 900 });
    expect((await control.oidcView())?.maxLifetimeSeconds).toBe(900);
    const plain = await setup();
    expect((await plain.control.oidcView())?.maxLifetimeSeconds).toBe(3600);
  });
});

describe("JWKS status for the panel card", () => {
  test("the view reports the refresh time and key count after a sign-in, and the last error code when fetching fails", async () => {
    const { clock, control, signer, base } = await setup();
    expect((await control.oidcView())?.keyCount).toBe(0);
    await control.authenticate(mint(signer, claimsFor(base, clock.now)));
    const healthy = await control.oidcView();
    expect(healthy?.keyCount).toBe(1);
    expect(healthy?.refreshedAt).toBeDefined();
    expect(healthy?.lastError).toBeUndefined();
    expect(healthy?.jwks).toBe("configured");
    expect(healthy?.jwksHost).toBe(new URL(base).host);

    const broken = await setup({ jwksUrl: "http://127.0.0.1:9/missing.json" });
    await broken.control.authenticate(
      mint(broken.signer, claimsFor(broken.base, broken.clock.now)),
    );
    const failed = await broken.control.oidcView();
    expect(failed?.lastError).toBe("oidc-discovery");
    expect(failed?.keyCount).toBe(0);
  });
});
