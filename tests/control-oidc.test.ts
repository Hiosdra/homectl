import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

// Key generation and loopback HTTP are slow on Windows.
setDefaultTimeout(60_000);

import {
  createHmac,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../src/control/engine";
import { startMcpServer } from "../src/control/mcp";
import { validateOidcConfigInput } from "../src/control/oidc";
import { HomectlError } from "../src/types";

const INVENTORY = `version: 1
machines:
  agent-host:
    description: Synthetic local device
    transport: local
    access: user
`;
const AUDIENCE = "homectl-mcp";
const SUBJECT = "subject-42";
const dirs: string[] = [];
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Signer {
  kid: string;
  alg: "RS256" | "ES256" | "EdDSA";
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeSigner(kid: string, alg: Signer["alg"]): Signer {
  const pair =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : alg === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "P-256" })
        : generateKeyPairSync("ed25519");
  return {
    kid,
    alg,
    privateKey: pair.privateKey,
    jwk: {
      ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid,
      use: "sig",
      alg,
    },
  };
}

const b64 = (value: unknown) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64url");

function mint(
  signer: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = b64({ alg: signer.alg, kid: signer.kid, typ: "JWT", ...header });
  const body = b64(claims);
  const input = Buffer.from(`${head}.${body}`);
  const signature =
    signer.alg === "RS256"
      ? sign("sha256", input, signer.privateKey)
      : signer.alg === "ES256"
        ? sign("sha256", input, {
            key: signer.privateKey,
            dsaEncoding: "ieee-p1363",
          })
        : sign(null, input, signer.privateKey);
  return `${head}.${body}.${signature.toString("base64url")}`;
}

// A synthetic issuer on loopback: discovery, JWKS, and a fetch counter.
async function issuer(initial: Signer[]) {
  const state = { keys: initial, jwksHits: 0 };
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({ issuer: base, jwks_uri: `${base}/jwks.json` });
      if (url.pathname === "/jwks.json") {
        state.jwksHits += 1;
        return Response.json({ keys: state.keys.map((k) => k.jwk) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, state };
}

async function plane(clock: { now: number }) {
  const dir = await mkdtemp(join(tmpdir(), "homectl-oidc-"));
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
  return control;
}

async function refusedWith(
  control: ControlPlane,
  code: string,
): Promise<boolean> {
  const entries = await control.auditEntries();
  const last = entries.at(-1)?.event;
  return (
    last?.event === "auth.rejected" &&
    last.reason === `OIDC token refused: ${code}`
  );
}

// Standard claims for a token that should be accepted right now.
function claims(clock: { now: number }, extra: Record<string, unknown> = {}) {
  const now = Math.floor(clock.now / 1000);
  return {
    iss: "",
    aud: AUDIENCE,
    sub: SUBJECT,
    iat: now,
    nbf: now,
    exp: now + 300,
    ...extra,
  };
}

async function setup() {
  const clock = { now: Date.now() };
  const rsa = makeSigner("rsa-1", "RS256");
  const { base, state } = await issuer([rsa]);
  const control = await plane(clock);
  await control.configureOidc({
    issuer: base,
    audience: AUDIENCE,
    jwksUrl: `${base}/jwks.json`,
  });
  const oidcClient = await control.createClient({
    id: "oidc-codex",
    name: "OIDC Codex",
    scopes: ["status:read", "plan:create"],
    hosts: ["agent-host"],
    oidc: { claim: "sub", value: SUBJECT },
  });
  const staticClient = await control.createClient({
    id: "static-codex",
    name: "Static Codex",
    scopes: ["status:read"],
    hosts: ["agent-host"],
  });
  return { clock, base, state, rsa, control, oidcClient, staticClient };
}

describe("OIDC access tokens for MCP clients", () => {
  test("a valid RS256 token authenticates the mapped client and is audited without the subject", async () => {
    const { clock, base, rsa, control } = await setup();
    const token = mint(rsa, claims(clock, { iss: base }));
    const identity = await control.authenticate(token);
    expect(identity?.id).toBe("oidc-codex");
    expect(identity?.scopes).toEqual(["status:read", "plan:create"]);
    const accepted = (await control.auditEntries()).find(
      (e) => e.event.event === "auth.oidc",
    );
    expect(accepted?.event.client).toBe("oidc-codex");
    expect(accepted?.event.reason).toContain("issuer=127.0.0.1:");
    expect(accepted?.event.reason).toContain("subject-sha256=");
  });

  test("ES256 and EdDSA tokens verify against their own key types", async () => {
    const clock = { now: Date.now() };
    const ec = makeSigner("ec-1", "ES256");
    const ed = makeSigner("ed-1", "EdDSA");
    const { base } = await issuer([ec, ed]);
    const control = await plane(clock);
    await control.configureOidc({
      issuer: base,
      audience: AUDIENCE,
      jwksUrl: `${base}/jwks.json`,
    });
    await control.createClient({
      id: "oidc-codex",
      name: "OIDC Codex",
      scopes: ["status:read"],
      hosts: ["agent-host"],
      oidc: { claim: "sub", value: SUBJECT },
    });
    expect(
      (await control.authenticate(mint(ec, claims(clock, { iss: base }))))?.id,
    ).toBe("oidc-codex");
    expect(
      (await control.authenticate(mint(ed, claims(clock, { iss: base }))))?.id,
    ).toBe("oidc-codex");
  });

  test("a wrong audience is refused", async () => {
    const { clock, base, rsa, control } = await setup();
    const token = mint(rsa, claims(clock, { iss: base, aud: "someone-else" }));
    expect(await control.authenticate(token)).toBeNull();
    expect(await refusedWith(control, "oidc-audience")).toBe(true);
  });

  test("a wrong issuer is refused", async () => {
    const { clock, rsa, control } = await setup();
    const token = mint(rsa, claims(clock, { iss: "https://idp.example.test" }));
    expect(await control.authenticate(token)).toBeNull();
    expect(await refusedWith(control, "oidc-issuer")).toBe(true);
  });

  test("an expired token is refused, but a token within the clock skew is accepted", async () => {
    const { clock, base, rsa, control } = await setup();
    const now = Math.floor(clock.now / 1000);
    expect(
      await control.authenticate(
        mint(rsa, claims(clock, { iss: base, exp: now - 300 })),
      ),
    ).toBeNull();
    expect(await refusedWith(control, "oidc-expired")).toBe(true);
    expect(
      (
        await control.authenticate(
          mint(rsa, claims(clock, { iss: base, exp: now - 30 })),
        )
      )?.id,
    ).toBe("oidc-codex");
  });

  test("a token whose nbf is in the future is refused", async () => {
    const { clock, base, rsa, control } = await setup();
    const now = Math.floor(clock.now / 1000);
    expect(
      await control.authenticate(
        mint(rsa, claims(clock, { iss: base, nbf: now + 3600 })),
      ),
    ).toBeNull();
    expect(await refusedWith(control, "oidc-not-before")).toBe(true);
  });

  test("alg none and HS256 are refused before any key is used", async () => {
    const { clock, base, rsa, state, control } = await setup();
    const payload = b64(claims(clock, { iss: base }));
    const none = `${b64({ alg: "none", kid: "rsa-1" })}.${payload}.`;
    expect(await control.authenticate(none)).toBeNull();
    expect(await refusedWith(control, "oidc-alg")).toBe(true);
    // HS256 keyed with the public JWK material: the classic key-confusion attack.
    const secret = JSON.stringify(state.keys[0]?.jwk ?? rsa.jwk);
    const head = b64({ alg: "HS256", kid: "rsa-1", typ: "JWT" });
    const hmac = createHmac("sha256", secret)
      .update(`${head}.${payload}`)
      .digest("base64url");
    expect(await control.authenticate(`${head}.${payload}.${hmac}`)).toBeNull();
    expect(await refusedWith(control, "oidc-alg")).toBe(true);
  });

  test("an unknown kid triggers one JWKS refresh, then refusal; a burst costs no extra fetches", async () => {
    const { clock, base, rsa, state, control } = await setup();
    // Load the keys with a valid token first.
    expect(
      await control.authenticate(mint(rsa, claims(clock, { iss: base }))),
    ).not.toBeNull();
    const before = state.jwksHits;
    clock.now += 31_000; // past the refresh rate limit
    const stranger = makeSigner("unknown-kid", "RS256");
    expect(
      await control.authenticate(mint(stranger, claims(clock, { iss: base }))),
    ).toBeNull();
    expect(state.jwksHits).toBe(before + 1);
    expect(await refusedWith(control, "oidc-unknown-key")).toBe(true);
    // Another unknown kid right away is refused without another fetch.
    expect(
      await control.authenticate(mint(stranger, claims(clock, { iss: base }))),
    ).toBeNull();
    expect(state.jwksHits).toBe(before + 1);
  });

  test("key rotation: a token signed with the new key is accepted after one refresh", async () => {
    const { clock, base, rsa, state, control } = await setup();
    expect(
      await control.authenticate(mint(rsa, claims(clock, { iss: base }))),
    ).not.toBeNull();
    // The issuer rotates: the old key is retired, a new one is published.
    const rotated = makeSigner("rsa-2", "RS256");
    state.keys = [rotated];
    clock.now += 31_000;
    expect(
      (await control.authenticate(mint(rotated, claims(clock, { iss: base }))))
        ?.id,
    ).toBe("oidc-codex");
    // The retired key stops verifying after the refresh.
    clock.now += 31_000;
    expect(
      await control.authenticate(mint(rsa, claims(clock, { iss: base }))),
    ).toBeNull();
  });

  test("a revoked client is refused even with a valid token", async () => {
    const { clock, base, rsa, control } = await setup();
    const token = mint(rsa, claims(clock, { iss: base }));
    expect((await control.authenticate(token))?.id).toBe("oidc-codex");
    await control.revokeClient("oidc-codex");
    expect(await control.authenticate(token)).toBeNull();
    expect(await refusedWith(control, "oidc-revoked")).toBe(true);
  });

  test("a valid token whose subject maps to no client is refused", async () => {
    const { clock, base, rsa, control } = await setup();
    const token = mint(rsa, claims(clock, { iss: base, sub: "nobody" }));
    expect(await control.authenticate(token)).toBeNull();
    expect(await refusedWith(control, "oidc-unmapped")).toBe(true);
  });

  test("static tokens keep working when OIDC is configured", async () => {
    const { control, staticClient } = await setup();
    const issued = staticClient.token;
    expect((await control.authenticate(issued))?.id).toBe("static-codex");
  });

  test("no token material in the audit journal: only the issuer host and a subject hash", async () => {
    const { clock, base, rsa, control } = await setup();
    const good = mint(rsa, claims(clock, { iss: base }));
    const bad = mint(rsa, claims(clock, { iss: base, aud: "nope" }));
    await control.authenticate(good);
    await control.authenticate(bad);
    const journal = JSON.stringify(await control.auditEntries());
    expect(journal).not.toContain(good);
    expect(journal).not.toContain(bad);
    expect(journal).not.toContain(SUBJECT);
    expect(journal).toContain("subject-sha256=");
  });

  test("discovery finds the JWKS when no JWKS URL is configured", async () => {
    const clock = { now: Date.now() };
    const rsa = makeSigner("rsa-disc", "RS256");
    const { base } = await issuer([rsa]);
    const control = await plane(clock);
    await control.configureOidc({ issuer: base, audience: AUDIENCE });
    await control.createClient({
      id: "oidc-codex",
      name: "OIDC Codex",
      scopes: ["status:read"],
      hosts: ["agent-host"],
      oidc: { claim: "sub", value: SUBJECT },
    });
    expect(
      (await control.authenticate(mint(rsa, claims(clock, { iss: base }))))?.id,
    ).toBe("oidc-codex");
  });

  test("the MCP endpoint advertises protected-resource metadata and challenges unauthenticated calls", async () => {
    const { clock, base, rsa, control } = await setup();
    const mcp = startMcpServer({ control, port: 0 });
    stops.push(() => mcp.stop());
    const origin = new URL(mcp.url).origin;
    const metadata = (await (
      await fetch(`${origin}/.well-known/oauth-protected-resource`)
    ).json()) as {
      resource: string;
      authorization_servers?: string[];
      bearer_methods_supported: string[];
    };
    expect(metadata.resource).toBe(`${origin}/mcp`);
    expect(metadata.authorization_servers).toEqual([base]);
    expect(metadata.bearer_methods_supported).toEqual(["header"]);
    const challenge = await fetch(mcp.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      `${origin}/.well-known/oauth-protected-resource`,
    );
    const token = mint(rsa, claims(clock, { iss: base }));
    const listed = await fetch(mcp.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
  });

  test("OIDC configuration refuses plain http to a remote host and empty audiences", () => {
    expect(() =>
      validateOidcConfigInput({
        issuer: "http://idp.example.test",
        audience: AUDIENCE,
      }),
    ).toThrow(HomectlError);
    expect(() =>
      validateOidcConfigInput({
        issuer: "https://idp.example.test",
        audience: "",
      }),
    ).toThrow(HomectlError);
    expect(
      validateOidcConfigInput({
        issuer: "http://127.0.0.1:9000",
        audience: AUDIENCE,
      }).issuer,
    ).toBe("http://127.0.0.1:9000");
  });

  test("a mapping needs OIDC configured and a unique identity", async () => {
    const clock = { now: Date.now() };
    const control = await plane(clock);
    await expect(
      control.createClient({
        id: "oidc-codex",
        name: "OIDC Codex",
        scopes: ["status:read"],
        hosts: ["agent-host"],
        oidc: { claim: "sub", value: SUBJECT },
      }),
    ).rejects.toMatchObject({ code: 2 });
    await control.configureOidc({
      issuer: "https://idp.example.test",
      audience: AUDIENCE,
    });
    await control.createClient({
      id: "oidc-codex",
      name: "OIDC Codex",
      scopes: ["status:read"],
      hosts: ["agent-host"],
      oidc: { claim: "sub", value: SUBJECT },
    });
    await expect(
      control.createClient({
        id: "oidc-other",
        name: "Other",
        scopes: ["status:read"],
        hosts: ["agent-host"],
        oidc: { claim: "sub", value: SUBJECT },
      }),
    ).rejects.toMatchObject({
      code: 2,
      message: expect.stringContaining("already mapped"),
    });
    const listed = (await control.listClients()).find(
      (c) => c.id === "oidc-codex",
    );
    expect(listed?.oidc).toEqual({
      issuerHost: "idp.example.test",
      claim: "sub",
      identityHash: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
    expect(JSON.stringify(listed)).not.toContain(SUBJECT);
  });
});
