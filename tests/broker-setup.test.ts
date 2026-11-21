// Guided setup on the broker (0.3, part 3). Progress lives in broker/setup.json as
// booleans and timestamps; detection beats anything stored; skip and resume work;
// completion needs every required step; the routes need the owner session and the
// Origin check; the file never holds a secret; and an assistant's "seen" time is
// kept apart from the client registry.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantSeen } from "../src/broker/assistant-seen";
import type { Broker } from "../src/broker/engine";
import { OwnerSessions } from "../src/broker/owner";
import { handler } from "../src/broker/server";
import { buildStatus, type SetupFacts } from "../src/broker/setup-detect";
import { SetupRoutes } from "../src/broker/setup-routes";
import {
  sanitizeSetup,
  SetupStore,
  SETUP_STEPS,
} from "../src/broker/setup-state";

const ORIGIN = "http://127.0.0.1:7451";
const PASSWORD = "setup test password";

const ready: SetupFacts = {
  vault: true,
  machines: 1,
  readyMachines: 1,
  assistants: 1,
  connectedAssistants: 1,
  requests: 1,
  resolvedApprovals: 1,
  permissionsRevision: 1,
  workspaceServer: false,
  pairedDevices: 0,
};
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
// The owner's session cookie, set by each test that signs in.
let cookieJar = "";
let facts: SetupFacts;
let store: SetupStore;
let owner: OwnerSessions;
let serve: ReturnType<typeof handler>;

function stateOf(
  status: { steps: { id: string; state: string }[] },
  id: string,
) {
  return status.steps.find((step) => step.id === id)?.state;
}

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
    new Request(`http://127.0.0.1:7450${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hcsetup-"));
  facts = { ...empty };
  store = new SetupStore(join(dir, "setup.json"));
  owner = new OwnerSessions({
    verify: async (secret: string) => secret === PASSWORD,
  });
  const routes = new SetupRoutes({
    store,
    facts: async () => facts,
  });
  serve = handler({
    broker: {} as Broker,
    clients: { authenticate: async () => null },
    owner,
    listen: { kind: "tcp", hostname: "127.0.0.1", port: 7450 },
    allowedOrigins: [ORIGIN],
    extensions: [routes],
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("detection overrides a stored skip", async () => {
  await store.update((file, at) => {
    file.steps.machine = { status: "skipped", at };
  });
  const status = buildStatus(await store.load(), ready);
  expect(stateOf(status, "machine")).toBe("done");
  expect(status.steps.find((step) => step.id === "machine")?.detected).toBe(
    true,
  );
});

test("skip and resume", async () => {
  cookieJar = await signedIn();
  const skip = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "skip", step: "assistant" },
    cookieJar,
  );
  expect(skip.status).toBe(200);
  let status = (await skip.json()) as {
    steps: { id: string; state: string }[];
  };
  expect(stateOf(status, "assistant")).toBe("skipped");

  const resume = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "reopen", step: "assistant" },
    cookieJar,
  );
  status = (await resume.json()) as typeof status;
  expect(stateOf(status, "assistant")).toBe("open");
});

test("completion needs every required step", async () => {
  facts = { ...ready, readyMachines: 0, machines: 0 };
  const missing = buildStatus(await store.load(), facts);
  expect(missing.completed).toBe(false);
  expect(missing.next).toBe("machine");
  expect(missing.counts.requiredDone).toBe(4);

  facts = { ...ready };
  // Optional steps stay open and do not block completion.
  const complete = buildStatus(await store.load(), facts);
  expect(complete.completed).toBe(true);
  expect(complete.counts.optionalDone).toBe(0);
  expect(complete.next).toBe("devices");
});

test("a skipped required step keeps setup open", async () => {
  facts = { ...ready, readyMachines: 0, machines: 0 };
  await store.update((file, at) => {
    file.steps.machine = { status: "skipped", at };
  });
  const status = buildStatus(await store.load(), facts);
  expect(stateOf(status, "machine")).toBe("skipped");
  expect(status.completed).toBe(false);
});

test("the owner routes need the owner session", async () => {
  const anonymous = await call("GET", "/v1/owner/setup");
  expect(anonymous.status).toBe(403);
  const forged = await call(
    "GET",
    "/v1/owner/setup",
    undefined,
    "hc_owner=hco_x",
  );
  expect(forged.status).toBe(403);
  const mark = await call("POST", "/v1/owner/setup/step", {
    action: "welcome",
  });
  expect(mark.status).toBe(403);
});

test("a progress mark needs the panel's origin", async () => {
  cookieJar = await signedIn();
  const crossSite = await serve(
    new Request("http://127.0.0.1:7450/v1/owner/setup/step", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        cookie: cookieJar,
      },
      body: JSON.stringify({ action: "welcome" }),
    }),
  );
  expect(crossSite.status).toBe(403);
});

test("the status read works signed in and returns the stored and detected state", async () => {
  cookieJar = await signedIn();
  const response = await call("GET", "/v1/owner/setup", undefined, cookieJar);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    steps: { id: string; required: boolean; detected: boolean }[];
    welcomed: boolean;
  };
  expect(body.steps.map((step) => step.id)).toEqual([...SETUP_STEPS]);
  expect(body.welcomed).toBe(false);
  expect(body.steps.find((step) => step.id === "vault")?.detected).toBe(false);
});

test("keep and done are limited to the steps they describe", async () => {
  cookieJar = await signedIn();
  const keepMachine = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "keep", step: "machine" },
    cookieJar,
  );
  expect(keepMachine.status).toBe(400);
  const keepPermissions = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "keep", step: "permissions" },
    cookieJar,
  );
  expect(keepPermissions.status).toBe(200);
  const doneVault = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "done", step: "vault" },
    cookieJar,
  );
  expect(doneVault.status).toBe(400);
  const doneNotifications = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "done", step: "notifications" },
    cookieJar,
  );
  expect(doneNotifications.status).toBe(200);
});

test("dismiss only after setup is complete", async () => {
  cookieJar = await signedIn();
  const early = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "dismiss" },
    cookieJar,
  );
  expect(early.status).toBe(400);
  facts = { ...ready };
  const late = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "dismiss" },
    cookieJar,
  );
  expect(late.status).toBe(200);
  const body = (await late.json()) as {
    dismissed: boolean;
    completed: boolean;
  };
  expect(body.completed).toBe(true);
  expect(body.dismissed).toBe(true);
});

test("the first complete read records when setup finished", async () => {
  cookieJar = await signedIn();
  facts = { ...ready };
  await call("GET", "/v1/owner/setup", undefined, cookieJar);
  const saved = await store.load();
  expect(typeof saved.completedAt).toBe("number");
});

test("setup.json holds no secrets, even when a request carries some", async () => {
  cookieJar = await signedIn();
  await call(
    "POST",
    "/v1/owner/setup/step",
    {
      action: "skip",
      step: "vault",
      password: PASSWORD,
      token: "hct_secret_value_that_must_not_be_stored",
    },
    cookieJar,
  );
  const text = await readFile(join(dir, "setup.json"), "utf8");
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain("hct_");
  expect(text).not.toContain("password");
  expect(text).not.toContain("token");
  if (process.platform !== "win32") {
    const mode = (await stat(join(dir, "setup.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  }
});

test("the file reader keeps only known fields with the right types", () => {
  const clean = sanitizeSetup({
    version: 1,
    welcomedAt: 5,
    secret: "hco_leak",
    steps: {
      vault: { status: "done", at: 9, token: "x" },
      unknown: { status: "done", at: 9 },
      machine: { status: "maybe", at: 9 },
    },
    completedAt: "not a number",
  });
  expect(clean).toEqual({
    version: 1,
    welcomedAt: 5,
    steps: { vault: { status: "done", at: 9 } },
  });
});

test("an unknown step or action is refused", async () => {
  cookieJar = await signedIn();
  const badStep = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "skip", step: "root-access" },
    cookieJar,
  );
  expect(badStep.status).toBe(400);
  const badAction = await call(
    "POST",
    "/v1/owner/setup/step",
    { action: "approve", step: "vault" },
    cookieJar,
  );
  expect(badAction.status).toBe(400);
});

test("assistant seen times survive a restart and do not touch the registry", async () => {
  const path = join(dir, "assistant-seen.json");
  const first = new AssistantSeen(path, () => 1_000);
  first.note("claude");
  expect(await first.lastSeen("claude")).toBe(1_000);
  // Let the throttled save finish.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = new AssistantSeen(path);
  expect(await second.lastSeen("claude")).toBe(1_000);
  expect(await second.lastSeen("codex")).toBeUndefined();
  const text = await readFile(path, "utf8");
  expect(text).not.toContain("hct_");
});

test("a corrupt setup file starts again without trusting anything in it", async () => {
  await writeFile(join(dir, "setup.json"), "{not json");
  const loaded = await store.load();
  expect(loaded).toEqual({ version: 1, steps: {} });
});
