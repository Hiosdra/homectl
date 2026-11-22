// The owner's setup path (step by step, or the AI agent): chosen on Welcome, kept in
// broker/setup.json, switchable at any time, and never a grant. These tests cover the
// stored value, its sanitising, the owner route that records it and the rule that a
// path choice alone completes no step.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerSessions } from "../src/broker/owner";
import type { Broker } from "../src/broker/engine";
import { handler } from "../src/broker/server";
import { buildStatus, type SetupFacts } from "../src/broker/setup-detect";
import { SetupRoutes } from "../src/broker/setup-routes";
import {
  isSetupPath,
  sanitizeSetup,
  SetupStore,
} from "../src/broker/setup-state";

const ORIGIN = "http://127.0.0.1:7452";
const PASSWORD = "setup path test password";

const empty: SetupFacts = {
  vault: false,
  machines: 0,
  readyMachines: 0,
  assistants: 0,
  connectedAssistants: 0,
  requests: 0,
  resolvedApprovals: 0,
  permissionsRevision: 0,
  workspaceServer: false,
  pairedDevices: 0,
};

let dir: string;
let store: SetupStore;
let owner: OwnerSessions;
let serve: ReturnType<typeof handler>;

async function signedIn(): Promise<string> {
  const session = await owner.login(PASSWORD, "panel");
  return `hc_owner=${session.token}`;
}

async function call(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  cookie?: string,
) {
  const headers: Record<string, string> = {};
  if (method === "POST") {
    headers["content-type"] = "application/json";
    headers.origin = ORIGIN;
  }
  if (cookie) headers.cookie = cookie;
  return serve(
    new Request(`http://127.0.0.1:7452${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hcpath-"));
  store = new SetupStore(join(dir, "setup.json"));
  owner = new OwnerSessions({
    verify: async (secret: string) => secret === PASSWORD,
  });
  serve = handler({
    broker: {} as Broker,
    clients: { authenticate: async () => null },
    owner,
    listen: { kind: "tcp", hostname: "127.0.0.1", port: 7452 },
    allowedOrigins: [ORIGIN],
    extensions: [new SetupRoutes({ store, facts: async () => empty })],
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("only the two known paths are accepted", () => {
  expect(isSetupPath("manual")).toBe(true);
  expect(isSetupPath("agent")).toBe(true);
  expect(isSetupPath("wizard")).toBe(false);
  expect(isSetupPath(undefined)).toBe(false);
});

test("a stored path survives a reload, and an unknown one is dropped", () => {
  expect(
    sanitizeSetup({ version: 1, setupPath: "agent", steps: {} }).setupPath,
  ).toBe("agent");
  expect(
    sanitizeSetup({ version: 1, setupPath: "root-shell", steps: {} }).setupPath,
  ).toBeUndefined();
});

test("the owner's panel records the path and it is read back on reload", async () => {
  const cookie = await signedIn();
  const chosen = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "path", path: "agent" },
    cookie,
  );
  expect(chosen.status).toBe(200);
  expect(((await chosen.json()) as { path: string }).path).toBe("agent");

  // A fresh store on the same file (a restart) still knows the choice.
  const reloaded = new SetupStore(join(dir, "setup.json"));
  expect((await reloaded.load()).setupPath).toBe("agent");
  const onDisk = await readFile(join(dir, "setup.json"), "utf8");
  expect(JSON.parse(onDisk).setupPath).toBe("agent");
});

test("the owner can switch paths at any time, and each switch is kept", async () => {
  const cookie = await signedIn();
  for (const path of ["agent", "manual", "agent"]) {
    const response = await call(
      "POST",
      "/v1/owner/setup/step",
      { action: "path", path },
      cookie,
    );
    expect(((await response.json()) as { path: string }).path).toBe(path);
  }
  const status = await call("GET", "/v1/owner/setup", undefined, cookie);
  expect(((await status.json()) as { path: string }).path).toBe("agent");
});

test("a value outside the two paths is refused and nothing is stored", async () => {
  const cookie = await signedIn();
  const refused = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "path", path: "shell" },
    cookie,
  );
  expect(refused.status).toBe(400);
  expect((await store.load()).setupPath).toBeUndefined();
});

test("choosing a path completes no step and shows no path before the owner picks one", async () => {
  const before = buildStatus(await store.load(), empty);
  expect(before.path).toBeNull();

  const cookie = await signedIn();
  await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "path", path: "agent" },
    cookie,
  );
  const after = buildStatus(await store.load(), empty);
  expect(after.path).toBe("agent");
  expect(after.counts.requiredDone).toBe(0);
  expect(after.completed).toBe(false);
  expect(after.steps.every((step) => step.state === "open")).toBe(true);
});

test("the path route needs the owner session and the panel origin", async () => {
  const anonymous = await call("POST", "/v1/owner/setup/step", {
    action: "path",
    path: "agent",
  });
  expect(anonymous.status).toBe(403);
  expect((await store.load()).setupPath).toBeUndefined();
});
