import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceLedger } from "../src/approvals/ledger";
import { BasicPolicy } from "../src/broker/basic-policy";
import { Broker } from "../src/broker/engine";
import { FileVerifier, OwnerSessions } from "../src/broker/owner";
import { handler } from "../src/broker/server";
import { BrokerStore } from "../src/broker/store";
import { loadOrCreateDeviceKey } from "../src/control/device-key";
import type { ClientIdentity } from "../src/control/types";

const PANEL = "http://127.0.0.1:7448";
const TOKEN = `hct_${"a".repeat(43)}`;
const PASSWORD = "correct horse battery";
const client: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["nas"],
};
let dir: string;
let broker: Broker;
let fetch: (req: Request) => Promise<Response>;
let ran: string[][];

function call(
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return fetch(
    new Request(`http://broker${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}
const agentAuth = { authorization: `Bearer ${TOKEN}` };

async function ownerToken() {
  const res = await call("/v1/owner/login", { password: PASSWORD });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-server-"));
  ran = [];
  broker = new Broker({
    store: new BrokerStore(dir),
    ledger: new NonceLedger(dir),
    key: await loadOrCreateDeviceKey(dir),
    device: { id: "dev-test-0000000000", name: "test" },
    policy: new BasicPolicy(),
    inventory: {
      machine: async (h) =>
        h === "nas"
          ? {
              description: "NAS",
              transport: "ssh",
              access: "full",
              user: "admin",
            }
          : undefined,
      hosts: async () => ["nas"],
    },
    executor: {
      run: async ({ argv }) => {
        ran.push(argv);
        return { exitCode: 0, stdout: "done", stderr: "" };
      },
    },
  });
  await broker.init();
  const verifier = new FileVerifier(join(dir, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  });
  await verifier.set(PASSWORD);
  fetch = handler({
    broker,
    clients: { authenticate: async (t) => (t === TOKEN ? client : null) },
    owner: new OwnerSessions(verifier),
    listen: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
    allowedOrigins: [PANEL],
  });
});
afterEach(async () => {
  await broker.settled();
  await rm(dir, { recursive: true, force: true });
});

describe("agent routes", () => {
  test("need a client token", async () => {
    expect((await call("/v1/whoami")).status).toBe(401);
    const res = await call("/v1/whoami", {}, agentAuth);
    expect(await res.json()).toMatchObject({ id: "codex-pc" });
  });

  test("exec with wait returns the finished result", async () => {
    const res = await call(
      "/v1/exec",
      { host: "nas", argv: ["uptime"], waitMs: 2000 },
      agentAuth,
    );
    expect(await res.json()).toMatchObject({
      state: "succeeded",
      result: { stdout: "done" },
    });
  });

  test("an owner token is useless on agent routes", async () => {
    const owner = await ownerToken();
    expect(
      (await call("/v1/whoami", {}, { authorization: `Bearer ${owner}` }))
        .status,
    ).toBe(401);
  });

  test("errors map to HTTP status without stack traces", async () => {
    const res = await call("/v1/exec", { host: "nas" }, agentAuth);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/\sat \S+ \(/);
  });
});

describe("owner routes", () => {
  test("a client token cannot reach owner routes", async () => {
    const res = await call(
      "/v1/owner/pending",
      {},
      { authorization: `Owner ${TOKEN}` },
    );
    expect(res.status).toBe(403);
  });

  test("wrong password, then lockout after five failures", async () => {
    for (let i = 0; i < 5; i++)
      expect((await call("/v1/owner/login", { password: "nope" })).status).toBe(
        403,
      );
    const res = await call("/v1/owner/login", { password: PASSWORD });
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toContain("wait a minute");
  });

  test("cookie requests need the panel origin (CSRF)", async () => {
    const login = await call(
      "/v1/owner/login",
      { password: PASSWORD },
      { origin: PANEL },
    );
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0] ?? "";
    expect((await call("/v1/owner/pending", {}, { cookie })).status).toBe(403);
    expect(
      (
        await call(
          "/v1/owner/pending",
          {},
          { cookie, origin: "http://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("/v1/owner/pending", {}, { cookie, origin: PANEL })).status,
    ).toBe(200);
  });

  test("the session cookie is Secure only when the panel origin is https", async () => {
    const httpsPanel = "https://homectl.lan.example.test";
    const verifier = new FileVerifier(join(dir, "owner.json"), {
      iterations: 1,
      memorySize: 1024,
      parallelism: 1,
    });
    const secureFetch = handler({
      broker,
      clients: { authenticate: async () => null },
      owner: new OwnerSessions(verifier),
      listen: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
      allowedOrigins: [PANEL, httpsPanel],
    });
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string>,
    ) =>
      secureFetch(
        new Request(`http://broker${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );

    const plain = await post(
      "/v1/owner/login",
      { password: PASSWORD },
      { origin: PANEL },
    );
    const plainCookie = plain.headers.get("set-cookie") ?? "";
    expect(plainCookie).toContain("HttpOnly");
    expect(plainCookie).toContain("SameSite=Strict");
    expect(plainCookie).toContain("Path=/v1/owner");
    expect(plainCookie).toContain("Max-Age=900");
    expect(plainCookie).not.toContain("Secure");

    const tls = await post(
      "/v1/owner/login",
      { password: PASSWORD },
      { origin: httpsPanel },
    );
    const tlsCookie = tls.headers.get("set-cookie") ?? "";
    expect(tlsCookie).toContain("HttpOnly");
    expect(tlsCookie).toContain("SameSite=Strict");
    expect(tlsCookie).toContain("Secure");

    // Logout clears the cookie with the same attributes, Secure included.
    const token = tlsCookie.split(";")[0] ?? "";
    const out = await post(
      "/v1/owner/logout",
      {},
      { origin: httpsPanel, cookie: token },
    );
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("HttpOnly");
  });

  test("approve flow: pending -> decide -> dispatched once", async () => {
    const planned = (await (
      await call(
        "/v1/exec",
        { host: "nas", argv: ["systemctl", "restart", "nginx"] },
        agentAuth,
      )
    ).json()) as { id: string; fingerprint: string; state: string };
    expect(planned.state).toBe("awaiting-approval");
    const owner = await ownerToken();
    const auth = { authorization: `Owner ${owner}` };
    const pending = (await (
      await call("/v1/owner/pending", {}, auth)
    ).json()) as { id: string }[];
    expect(pending.map((p) => p.id)).toEqual([planned.id]);
    const res = await call(
      "/v1/owner/decide",
      {
        operationId: planned.id,
        fingerprint: planned.fingerprint,
        decision: "approve-once",
      },
      auth,
    );
    expect(res.status).toBe(200);
    await broker.settled();
    expect(ran).toEqual([["systemctl", "restart", "nginx"]]);
  });

  test("step-up needs the password again, and a wrong one is refused", async () => {
    const planned = (await (
      await call(
        "/v1/exec",
        { host: "nas", argv: ["rm", "-rf", "/srv/x"] },
        agentAuth,
      )
    ).json()) as { id: string; fingerprint: string };
    const auth = { authorization: `Owner ${await ownerToken()}` };
    const decide = (extra: Record<string, unknown>) =>
      call(
        "/v1/owner/decide",
        {
          operationId: planned.id,
          fingerprint: planned.fingerprint,
          decision: "approve-once",
          ...extra,
        },
        auth,
      );
    expect((await decide({})).status).toBe(403);
    expect((await decide({ password: "wrong" })).status).toBe(403);
    expect((await decide({ password: PASSWORD })).status).toBe(200);
    await broker.settled();
    expect(ran).toEqual([["rm", "-rf", "/srv/x"]]);
  });

  test("an agent cannot approve its own plan through agent routes", async () => {
    const planned = (await (
      await call(
        "/v1/exec",
        { host: "nas", argv: ["systemctl", "restart", "x"] },
        agentAuth,
      )
    ).json()) as { id: string; fingerprint: string };
    const res = await call(
      "/v1/owner/decide",
      {
        operationId: planned.id,
        fingerprint: planned.fingerprint,
        decision: "approve-once",
      },
      agentAuth,
    );
    expect(res.status).toBe(403);
    await broker.settled();
    expect(ran).toEqual([]);
  });
});
