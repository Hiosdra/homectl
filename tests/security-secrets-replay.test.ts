// Replay of secret provide and use requests (homelab #21 §5: "replay ... cancel/
// expiry"). A provide can happen once per request; a use stops working when its
// reference is revoked, locked, cancelled or past its one-hour window, and no
// refusal ever carries the value. Canary values only.
import { describe, expect, test } from "bun:test";
import { SecretService } from "../src/broker/secret-service";
import type { ClientIdentity } from "../src/control/types";
import type { SecretDestination } from "../src/core/contracts";
import { SecretBroker, SECRET_VALUE_TTL_MS } from "../src/secrets";
import { HomectlError } from "../src/types";

const PASSWORD = "owner-replay-pass";
const CANARY = "CANARY-replay-4b8e-do-not-leak";
const SECOND = "CANARY-replay-9f0a-second-value";
const START = 1_800_000_000_000;
const client: ClientIdentity = {
  id: "codex-pc",
  name: "Codex",
  scopes: ["plan:create", "status:read"],
  hosts: ["pc"],
};
const destination: SecretDestination = {
  kind: "ssh-stdin",
  host: "pc",
  argv: ["docker", "login", "--password-stdin"],
};

function harness() {
  let clock = START;
  const ran: { argv: string[]; stdin?: string }[] = [];
  const secrets = new SecretBroker({
    now: () => clock,
    knownHost: (host) => host === "pc",
  });
  const service = new SecretService({
    secrets,
    inventory: {
      machine: async (host) =>
        host === "pc"
          ? { description: "this computer", transport: "local", access: "user" }
          : undefined,
      hosts: async () => ["pc"],
    },
    executor: {
      run: async ({ argv, stdin }) => {
        ran.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });
  const stepUp = async (password: unknown) => {
    if (password !== PASSWORD)
      throw new HomectlError(3, "Confirm with the owner password");
  };
  const agent = (path: string, input: Record<string, unknown>) =>
    service.agent(path, input, client) as Promise<Record<string, unknown>>;
  const owner = (path: string, input: Record<string, unknown>) =>
    service.owner(path, input, stepUp) as Promise<Record<string, unknown>>;
  return {
    ran,
    secrets,
    agent,
    owner,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function requestId(
  h: ReturnType<typeof harness>,
  ttlMs?: number,
): Promise<string> {
  const view = await h.agent("/v1/secret/request", {
    purpose: "registry login",
    destination,
    fields: [{ name: "token" }],
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  return view.id as string;
}

async function provide(
  h: ReturnType<typeof harness>,
  id: string,
  value: string,
) {
  return h.owner("/v1/owner/secrets/provide", {
    id,
    values: { token: value },
    retention: "ephemeral",
    password: PASSWORD,
  });
}

async function refusedWith(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

async function provided(h: ReturnType<typeof harness>) {
  const id = await requestId(h);
  await provide(h, id, CANARY);
  const status = await h.agent("/v1/secret/status", { id });
  return { id, ref: status.ref as string };
}

const use = (h: ReturnType<typeof harness>, ref: string) =>
  h.agent("/v1/secret/use", { ref, destination });

describe("replay of a provide request", () => {
  test("a second provide of the same request is refused and cannot replace the first value", async () => {
    const h = harness();
    const id = await requestId(h);
    await provide(h, id, CANARY);
    const message = await refusedWith(() => provide(h, id, SECOND));
    expect(message).toBe("secret request is not pending");
    expect(message).not.toContain(SECOND);
    const status = await h.agent("/v1/secret/status", { id });
    await use(h, status.ref as string);
    expect(h.ran).toEqual([{ argv: destination.argv, stdin: CANARY }]);
  });

  test("a provide replayed after decline is refused and mints no reference", async () => {
    const h = harness();
    const id = await requestId(h);
    await h.owner("/v1/owner/secrets/decline", { id });
    await refusedWith(() => provide(h, id, CANARY));
    const status = await h.agent("/v1/secret/status", { id });
    expect(status.state).toBe("declined");
    expect(status.ref).toBeUndefined();
  });

  test("a provide replayed after the requester cancelled is refused", async () => {
    const h = harness();
    const id = await requestId(h);
    await h.agent("/v1/secret/cancel", { id });
    await refusedWith(() => provide(h, id, CANARY));
    expect((await h.agent("/v1/secret/status", { id })).state).toBe(
      "cancelled",
    );
  });

  test("a provide replayed after the request window expired is refused", async () => {
    const h = harness();
    const id = await requestId(h, 60_000);
    h.advance(60_000);
    await refusedWith(() => provide(h, id, CANARY));
    expect((await h.agent("/v1/secret/status", { id })).state).toBe("expired");
  });
});

describe("replay of a use request", () => {
  test("a use replayed after revoke is refused, and the refusal carries no value", async () => {
    const h = harness();
    const { ref } = await provided(h);
    await use(h, ref);
    await h.owner("/v1/owner/secrets/revoke", { ref });
    const message = await refusedWith(() => use(h, ref));
    expect(message).toBe("secret reference is not usable");
    expect(message).not.toContain(CANARY);
    expect(h.ran).toHaveLength(1);
  });

  test("a use replayed after the one-hour window is refused", async () => {
    const h = harness();
    const { ref } = await provided(h);
    h.advance(SECRET_VALUE_TTL_MS);
    expect(await refusedWith(() => use(h, ref))).toBe(
      "secret reference is not usable",
    );
    expect(h.ran).toEqual([]);
  });

  test("a use replayed after the vault is locked is refused", async () => {
    const h = harness();
    const { ref } = await provided(h);
    // The daemon's lock hook calls exactly this on the secret broker.
    h.secrets.lock();
    expect(await refusedWith(() => use(h, ref))).toBe(
      "secret reference is not usable",
    );
    expect(h.ran).toEqual([]);
  });

  test("a use replayed after the requester cancelled the provided request is refused", async () => {
    const h = harness();
    const { id, ref } = await provided(h);
    await h.agent("/v1/secret/cancel", { id });
    expect(await refusedWith(() => use(h, ref))).toBe(
      "secret reference is not usable",
    );
    expect(h.ran).toEqual([]);
  });

  test("a use replayed with another destination is refused and runs nothing new", async () => {
    const h = harness();
    const { ref } = await provided(h);
    await use(h, ref);
    const other = { ...destination, argv: ["sh", "-c", "cat"] };
    expect(
      await refusedWith(() =>
        h.agent("/v1/secret/use", { ref, destination: other }),
      ),
    ).toBe("destination does not match the secret request");
    expect(h.ran).toHaveLength(1);
  });
});
