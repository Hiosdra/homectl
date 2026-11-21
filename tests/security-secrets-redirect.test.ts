// Redirects on a secret destination (homelab #21 §5: "restrict actual
// destination/redirects"). The broker sends the secret header once to the
// approved URL. A server that answers with a 3xx must not make the broker send
// the secret again to the Location, and the redirect body is redacted.
// Real loopback servers; canary values only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SecretService } from "../src/broker/secret-service";
import type { ClientIdentity } from "../src/control/types";
import { SecretBroker } from "../src/secrets";

const PASSWORD = "owner-redirect-pass";
const CANARY = "CANARY-redirect-6e3d-do-not-leak";
const client: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["pc"],
};

type Server = ReturnType<typeof Bun.serve>;
const servers: Server[] = [];
// Requests that reached the redirect target.
let landed: string[] = [];
// Requests that reached the approved URL, with the header they carried.
let approved: (string | null)[] = [];

beforeEach(() => {
  landed = [];
  approved = [];
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

// The redirect target. Any request that reaches it is recorded.
function target(): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      landed.push(req.headers.get("authorization") ?? "none");
      return new Response("landed", { status: 200 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/landing`;
}

// The approved URL: a careless upstream that answers with a redirect and echoes
// the header it received. `location` may point anywhere, including itself.
function upstream(status: number, location: (self: string) => string): string {
  let self = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      approved.push(req.headers.get("authorization"));
      return new Response(
        `moved; you sent ${req.headers.get("authorization") ?? "nothing"}`,
        { status, headers: { location: location(self) } },
      );
    },
  });
  servers.push(server);
  self = `http://127.0.0.1:${server.port}/submit`;
  return self;
}

// Provides a canary through the owner path, then uses it against `url`.
async function useAgainst(url: string) {
  const now = 1_800_000_000_000;
  const secrets = new SecretBroker({ now: () => now, knownHost: () => false });
  const service = new SecretService({
    secrets,
    inventory: { machine: async () => undefined, hosts: async () => [] },
    executor: {
      run: async () => {
        throw new Error("no executor for http destinations");
      },
    },
  });
  const destination = { kind: "http-header", url, header: "Authorization" };
  const request = (await service.agent(
    "/v1/secret/request",
    { purpose: "API token", destination, fields: [{ name: "token" }] },
    client,
  )) as { id: string };
  await service.owner(
    "/v1/owner/secrets/provide",
    {
      id: request.id,
      values: { token: CANARY },
      retention: "ephemeral",
      password: PASSWORD,
    },
    async (password) => {
      if (password !== PASSWORD) throw new Error("wrong password");
    },
  );
  const status = (await service.agent(
    "/v1/secret/status",
    { id: request.id },
    client,
  )) as { ref: string };
  return (await service.agent(
    "/v1/secret/use",
    { ref: status.ref, destination },
    client,
  )) as { status?: number; body?: string };
}

describe("secret destinations and redirects", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`a ${status} from the approved URL is not followed with the secret`, async () => {
      const landing = target();
      const entry = upstream(status, () => landing);
      const result = await useAgainst(entry);
      expect(result.status).toBe(status);
      // The approved URL got the header once; the Location got nothing.
      expect(approved).toEqual([`${CANARY}`]);
      expect(landed).toEqual([]);
      // The echoed header is redacted before the agent sees the body.
      expect(result.body).toContain("moved; you sent");
      expect(JSON.stringify(result)).not.toContain(CANARY);
    });
  }

  test("a redirect that points back at the approved URL is not followed", async () => {
    const entry = upstream(302, (self) => self);
    const result = await useAgainst(entry);
    expect(result.status).toBe(302);
    expect(approved).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});
