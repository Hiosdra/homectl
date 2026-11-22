// Agent-driven setup on the broker (0.3 acceptance). An agent client may read the
// setup status and the machines its own grant covers, and nothing else of the setup.
// Owner steps (password, typed fingerprint, keys, permissions, backups) stay on the
// owner routes, which an agent token can never reach. No address, key or probe error
// text is ever returned to an agent.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientIdentity } from "../src/control/types";
import { OwnerSessions } from "../src/broker/owner";
import type { Broker } from "../src/broker/engine";
import { handler } from "../src/broker/server";
import type { SetupFacts } from "../src/broker/setup-detect";
import {
  machineSummaries,
  type MachineSummary,
} from "../src/broker/setup-agent";
import { SetupRoutes } from "../src/broker/setup-routes";
import { SetupStore } from "../src/broker/setup-state";
import { mcpHttpRoute } from "../src/mcp/http";

const ORIGIN = "http://127.0.0.1:7453";
const PASSWORD = "agent setup test password";
const AGENT_TOKEN = "agent-token-for-tests";
const OTHER_TOKEN = "other-agent-token";

const facts: SetupFacts = {
  vault: true,
  machines: 2,
  readyMachines: 1,
  assistants: 1,
  connectedAssistants: 1,
  requests: 0,
  resolvedApprovals: 0,
  permissionsRevision: 0,
  workspaceServer: false,
  pairedDevices: 0,
};

// Two machines: the agent is granted "nas" only. Addresses and probe text are
// included here on purpose, so the tests can prove they never leave the broker.
const machines: MachineSummary[] = machineSummaries([
  {
    name: "nas",
    access: "observe",
    pinned: "SHA256:fingerprint-nas",
    probe: { ok: true },
  },
  {
    name: "pve",
    access: "user",
    pinned: null,
    probe: { ok: false },
  },
]);

const identities: Record<string, ClientIdentity> = {
  [AGENT_TOKEN]: {
    id: "codex",
    name: "Codex",
    scopes: [],
    hosts: ["nas"],
  },
  [OTHER_TOKEN]: {
    id: "claude",
    name: "Claude",
    scopes: [],
    hosts: [],
  },
};

let dir: string;
let owner: OwnerSessions;
let serve: ReturnType<typeof handler>;

async function signedIn(): Promise<string> {
  const session = await owner.login(PASSWORD, "panel");
  return `hc_owner=${session.token}`;
}

async function call(
  method: "GET" | "POST",
  path: string,
  options: {
    body?: Record<string, unknown>;
    bearer?: string;
    cookie?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (method === "POST") {
    headers["content-type"] = "application/json";
    if (!options.bearer) headers.origin = ORIGIN;
  }
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.cookie) headers.cookie = options.cookie;
  return serve(
    new Request(`http://127.0.0.1:7453${path}`, {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hcagentsetup-"));
  owner = new OwnerSessions({
    verify: async (secret: string) => secret === PASSWORD,
  });
  const store = new SetupStore(join(dir, "setup.json"));
  const setup = new SetupRoutes({
    store,
    facts: async () => facts,
    machines: async () => machines,
  });
  serve = handler({
    broker: {} as Broker,
    clients: {
      authenticate: async (token) =>
        token ? (identities[token] ?? null) : null,
    },
    owner,
    listen: { kind: "tcp", hostname: "127.0.0.1", port: 7453 },
    allowedOrigins: [ORIGIN],
    extensions: [
      setup,
      mcpHttpRoute({ broker: {} as Broker, secrets: {} as never, setup }),
    ],
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("an agent reads the setup status, with who acts on each step", async () => {
  const response = await call("POST", "/v1/setup/status", {
    bearer: AGENT_TOKEN,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    steps: { id: string; who: string; state: string }[];
    ownerNote: string;
    next: string | null;
    facts?: unknown;
  };
  expect(body.facts).toBeUndefined();
  expect(body.ownerNote).toContain("Steps marked owner");
  expect(body.steps.find((step) => step.id === "vault")?.who).toBe("owner");
  expect(body.steps.find((step) => step.id === "first-request")?.who).toBe(
    "agent",
  );
  expect(body.steps.find((step) => step.id === "vault")?.state).toBe("done");
});

test("an agent sees only the machines its own grant names, without addresses", async () => {
  const response = await call("POST", "/v1/setup/machines", {
    bearer: AGENT_TOKEN,
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual([
    { name: "nas", access: "observe", pinned: true, ready: true },
  ]);
  expect(text).not.toContain("pve");
  expect(text).not.toContain("fingerprint");
  expect(text).not.toContain("SHA256");
});

test("an agent with no machine grant sees no machines", async () => {
  const response = await call("POST", "/v1/setup/machines", {
    bearer: OTHER_TOKEN,
  });
  expect(await response.json()).toEqual([]);
});

test("setup reads need an agent token and a POST", async () => {
  const anonymous = await call("POST", "/v1/setup/status");
  expect(anonymous.status).toBe(401);
  const wrongMethod = await call("GET", "/v1/setup/status", {
    bearer: AGENT_TOKEN,
  });
  expect(wrongMethod.status).toBe(405);
});

test("an agent token is refused on every owner setup and machine route", async () => {
  const routes: [string, "GET" | "POST", Record<string, unknown>?][] = [
    ["/v1/owner/setup", "GET"],
    ["/v1/owner/setup/step", "POST", { action: "path", path: "agent" }],
    ["/v1/owner/setup/step", "POST", { action: "done", step: "notifications" }],
    ["/v1/owner/hosts", "GET"],
    ["/v1/owner/hosts/enroll", "POST", { name: "nas", password: PASSWORD }],
    ["/v1/owner/hosts/access", "POST", { name: "nas", access: "user" }],
    ["/v1/owner/hosts/probe", "POST", { name: "nas" }],
    ["/v1/owner/policy/preset", "POST", { preset: "delegated" }],
    ["/v1/owner/clients/create", "POST", { id: "x", name: "x", hosts: [] }],
    // The approval of a setup request, with its typed fingerprint: owner only.
    [
      "/v1/owner/decide",
      "POST",
      {
        operationId: "op_none",
        fingerprint: "f",
        decision: "approve-once",
        password: PASSWORD,
        confirmFingerprint: "SHA256:none",
      },
    ],
  ];
  for (const [path, method, body] of routes) {
    const response = await call(method, path, {
      bearer: AGENT_TOKEN,
      ...(body === undefined ? {} : { body }),
    });
    expect([401, 403]).toContain(response.status);
  }
});

test("an owner session cannot make a setup request: only an agent token can", async () => {
  const cookie = await signedIn();
  const response = await call("POST", "/v1/setup/request/scan", {
    cookie,
    body: { address: "192.0.2.44" },
  });
  expect(response.status).toBe(401);
});

test("an owner session cookie is not an agent token on the agent setup routes", async () => {
  const cookie = await signedIn();
  const response = await call("POST", "/v1/setup/status", { cookie });
  expect(response.status).toBe(401);
});

test("the agent's MCP tools read the same setup, and nothing else", async () => {
  const mcp = (id: number, name: string) =>
    call("POST", "/mcp", {
      bearer: AGENT_TOKEN,
      body: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: {} },
      },
    });
  const status = await mcp(1, "setup_status");
  const statusText = JSON.stringify(await status.json());
  expect(statusText).toContain("ownerNote");
  expect(statusText).not.toContain('isError":true');

  const listed = await mcp(2, "setup_machines");
  const listedText = JSON.stringify(await listed.json());
  expect(listedText).toContain("nas");
  expect(listedText).not.toContain("pve");
  expect(listedText).not.toContain("fingerprint");
});
