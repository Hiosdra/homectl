import { describe, expect, test } from "bun:test";
import {
  type BrokerRequestView,
  canaryLeaks,
  SecretBroker,
  type SecretBrokerOptions,
  type SecretRequestInput,
  type SecretUseOptions,
  type VaultPort,
} from "../src/secrets";
import { HomectlError } from "../src/types";

// Canary only. Never a real credential.
const CANARY = "CANARY-homectl-7Qz9-do-not-leak";
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const KNOWN_HOSTS = new Set(["ext-host-01", "ext-host-02"]);

function memoryVault(): VaultPort & {
  store: Map<string, Record<string, string>>;
  metas: unknown[];
} {
  const store = new Map<string, Record<string, string>>();
  const metas: unknown[] = [];
  let counter = 0;
  return {
    store,
    metas,
    async save(_name, values, meta) {
      counter += 1;
      const id = `vault-${counter}`;
      store.set(id, { ...values });
      metas.push(meta);
      return id;
    },
    async load(secretId) {
      const found = store.get(secretId);
      return found ? { ...found } : undefined;
    },
  };
}

function harness(overrides: Partial<SecretBrokerOptions> = {}) {
  let now = 1_000_000;
  let counter = 0;
  const vault = memoryVault();
  const options: SecretBrokerOptions = {
    now: () => now,
    knownHost: (host) => KNOWN_HOSTS.has(host),
    vault,
    random: (bytes) => {
      counter += 1;
      return Uint8Array.from(
        { length: bytes },
        (_, i) => (counter * 31 + i * 7) & 0xff,
      );
    },
    ...overrides,
  };
  return {
    broker: new SecretBroker(options),
    vault,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function sshInput(
  overrides: Partial<SecretRequestInput> = {},
): SecretRequestInput {
  return {
    client: "agent-one",
    task: "task-1",
    purpose: "Rotate the test account password",
    destination: { kind: "ssh-stdin", host: "ext-host-01", argv: ["chpasswd"] },
    fields: [{ name: "password", label: "Password", kind: "password" }],
    ...overrides,
  };
}

function thrownBy(fn: () => unknown): HomectlError {
  try {
    fn();
  } catch (error) {
    if (error instanceof HomectlError) return error;
    throw error;
  }
  throw new Error("expected a HomectlError");
}

async function rejectedWith(promise: Promise<unknown>): Promise<HomectlError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HomectlError) return error;
    throw error;
  }
  throw new Error("expected a HomectlError");
}

function refIn(view: BrokerRequestView): string {
  if (!view.ref) throw new Error("expected a reference");
  return view.ref;
}

const TARGET: SecretUseOptions = {
  client: "agent-one",
  task: "task-1",
  destination: { kind: "ssh-stdin", host: "ext-host-01", argv: ["chpasswd"] },
};

describe("secret broker: absolute one-hour TTL", () => {
  test("provided value is usable at +59m, gone at +60m, and use does not extend it", async () => {
    const { broker, advance } = harness();
    const request = broker.request(sshInput());
    const provided = await broker.provide(
      request.id,
      { password: CANARY },
      { retention: "ephemeral" },
    );
    const ref = refIn(provided);
    expect(provided.valueExpiresAt).toBe(1_000_000 + HOUR);
    expect(ref).toMatch(/^sref_[A-Za-z0-9_-]{24}$/);

    advance(59 * MINUTE);
    expect((await broker.use(ref, TARGET)).password).toBe(CANARY);
    expect(broker.status(request.id, "agent-one").state).toBe("provided");

    advance(MINUTE);
    const gone = await rejectedWith(broker.use(ref, TARGET));
    expect(gone.code).toBe(3);
    expect(gone.message).toBe("secret reference is not usable");
    expect(broker.status(request.id, "agent-one").state).toBe("expired");
  });

  test("the pending request expires on its own clock and cannot be provided afterwards", async () => {
    const { broker, advance } = harness();
    const request = broker.request(sshInput({ requestTtlMs: 2 * MINUTE }));
    advance(2 * MINUTE);
    expect(broker.status(request.id, "agent-one").state).toBe("expired");
    const error = await rejectedWith(
      broker.provide(
        request.id,
        { password: CANARY },
        { retention: "ephemeral" },
      ),
    );
    expect(error.message).toBe("secret request is not pending");
  });
});

describe("secret broker: request lifecycle", () => {
  test("lock drops ephemeral values and the reference stops working", async () => {
    const { broker } = harness();
    const request = broker.request(sshInput());
    const ref = refIn(
      await broker.provide(
        request.id,
        { password: CANARY },
        { retention: "ephemeral" },
      ),
    );
    broker.lock();
    expect(broker.status(request.id, "agent-one").state).toBe("revoked");
    expect((await rejectedWith(broker.use(ref, TARGET))).code).toBe(3);
  });

  test("cancel drops the value; only the requesting client may cancel", async () => {
    const { broker } = harness();
    const request = broker.request(sshInput());
    const ref = refIn(
      await broker.provide(
        request.id,
        { password: CANARY },
        { retention: "ephemeral" },
      ),
    );
    const other = thrownBy(() => broker.cancel(request.id, "agent-two"));
    expect(other.message).toBe("secret request not found");
    expect(broker.cancel(request.id, "agent-one").state).toBe("cancelled");
    expect((await rejectedWith(broker.use(ref, TARGET))).message).toBe(
      "secret reference is not usable",
    );
  });

  test("decline stops a pending request from being provided", async () => {
    const { broker } = harness();
    const request = broker.request(sshInput());
    expect(broker.decline(request.id).state).toBe("declined");
    const error = await rejectedWith(
      broker.provide(
        request.id,
        { password: CANARY },
        { retention: "ephemeral" },
      ),
    );
    expect(error.code).toBe(3);
    expect(error.message).toBe("secret request is not pending");
  });

  test("revoke ends the reference; replay after revoke is rejected", async () => {
    const { broker } = harness();
    const request = broker.request(sshInput());
    const ref = refIn(
      await broker.provide(
        request.id,
        { password: CANARY },
        { retention: "ephemeral" },
      ),
    );
    expect((await broker.use(ref, TARGET)).password).toBe(CANARY);
    broker.revoke(ref);
    expect((await rejectedWith(broker.use(ref, TARGET))).message).toBe(
      "secret reference is not usable",
    );
    expect(thrownBy(() => broker.revoke(ref)).code).toBe(3);
  });

  test("identical pending requests are deduplicated; a different destination is not", () => {
    const { broker } = harness();
    const first = broker.request(sshInput());
    const again = broker.request(
      sshInput({ purpose: "same request, reworded" }),
    );
    expect(again.id).toBe(first.id);
    const other = broker.request(
      sshInput({
        destination: {
          kind: "ssh-stdin",
          host: "ext-host-02",
          argv: ["chpasswd"],
        },
      }),
    );
    expect(other.id).not.toBe(first.id);
    const adminVariant = broker.request(sshInput({ admin: true }));
    expect(adminVariant.id).not.toBe(first.id);
    const requested = broker
      .history()
      .filter((item) => item.action === "requested");
    expect(requested).toHaveLength(3);
  });

  test("a client may hold at most 32 pending requests", () => {
    const { broker } = harness();
    for (let i = 0; i < 32; i++)
      broker.request(sshInput({ task: `task-${i}` }));
    const error = thrownBy(() => broker.request(sshInput({ task: "task-32" })));
    expect(error.code).toBe(3);
    expect(
      broker.request(sshInput({ client: "agent-two", task: "task-32" })).state,
    ).toBe("pending");
  });

  test("provide must cover exactly the declared fields with bounded values", async () => {
    const { broker } = harness();
    const request = broker.request(sshInput());
    const cases: Record<string, unknown>[] = [
      {},
      { password: CANARY, extra: CANARY },
      { password: "" },
      { password: "x".repeat(16_385) },
    ];
    for (const values of cases) {
      const error = await rejectedWith(
        broker.provide(request.id, values, { retention: "ephemeral" }),
      );
      expect(error.code).toBe(2);
    }
    expect(broker.status(request.id, "agent-one").state).toBe("pending");
  });

  test("invalid request input is rejected with usage errors", () => {
    const { broker } = harness();
    const bad: SecretRequestInput[] = [
      sshInput({ purpose: "" }),
      sshInput({ purpose: "x".repeat(501) }),
      sshInput({ fields: [] }),
      sshInput({ fields: [{ name: "Password" }] }),
      sshInput({ fields: [{ name: "a" }, { name: "a" }] }),
      sshInput({
        fields: [{ name: "password", kind: "other" as "password" }],
      }),
      sshInput({ client: "owner" }),
      sshInput({
        destination: { kind: "ssh-stdin", host: "unknown-host", argv: ["x"] },
      }),
    ];
    for (const input of bad)
      expect(thrownBy(() => broker.request(input)).code).toBe(2);
  });

  test("expired pending requests are swept and recorded", () => {
    const { broker, advance } = harness();
    broker.request(sshInput({ requestTtlMs: MINUTE }));
    advance(MINUTE);
    broker.sweep();
    expect(broker.history().map((item) => item.action)).toEqual([
      "requested",
      "expired",
    ]);
  });
});

describe("secret broker: saved retention", () => {
  test("saved values go to the vault, the reference works, and memory expiry falls back to the vault", async () => {
    const { broker, vault, advance } = harness();
    const request = broker.request(sshInput());
    const provided = await broker.provide(
      request.id,
      { password: CANARY },
      { retention: "saved", saveName: "test_account_pw" },
    );
    expect(provided.retention).toBe("saved");
    expect(vault.store.size).toBe(1);
    expect(canaryLeaks([JSON.stringify(vault.metas)], [CANARY])).toEqual([]);

    const ref = refIn(provided);
    advance(HOUR + MINUTE);
    expect((await broker.use(ref, TARGET)).password).toBe(CANARY);
  });

  test("saved retention without a vault or with an invalid save name is refused", async () => {
    const { broker } = harness({ vault: undefined });
    const request = broker.request(sshInput());
    const noVault = await rejectedWith(
      broker.provide(
        request.id,
        { password: CANARY },
        { retention: "saved", saveName: "x" },
      ),
    );
    expect(noVault.code).toBe(2);
    const withVault = harness();
    const second = withVault.broker.request(sshInput());
    const badName = await rejectedWith(
      withVault.broker.provide(
        second.id,
        { password: CANARY },
        { retention: "saved", saveName: "Bad Name" },
      ),
    );
    expect(badName.code).toBe(2);
  });

  test("lock keeps saved secrets in the vault; the reference resolves through the vault", async () => {
    const { broker, vault } = harness();
    const request = broker.request(sshInput());
    const ref = refIn(
      await broker.provide(
        request.id,
        { password: CANARY },
        { retention: "saved", saveName: "keep_me" },
      ),
    );
    broker.lock();
    expect(vault.store.size).toBe(1);
    expect((await broker.use(ref, TARGET)).password).toBe(CANARY);
  });
});

describe("secret broker: history carries no values", () => {
  test("history records contain no canary in raw, encoded or URL-encoded form", async () => {
    const { broker } = harness();
    const request = broker.request(sshInput());
    const ref = refIn(
      await broker.provide(
        request.id,
        { password: CANARY },
        { retention: "ephemeral" },
      ),
    );
    await broker.use(ref, TARGET);
    broker.cancel(request.id, "agent-one");
    const serialized = JSON.stringify(broker.history());
    expect(serialized).toContain("provided");
    expect(canaryLeaks([serialized], [CANARY])).toEqual([]);
  });
});

describe("secret broker: concurrency guards", () => {
  test("lock or decline during a saved provide: nothing is kept in memory", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vault: VaultPort = {
      async save() {
        await gate;
        return "vault-gated";
      },
      async load() {
        return undefined;
      },
    };
    const broker = new SecretBroker({
      now: () => 1_000_000,
      knownHost: (host) => KNOWN_HOSTS.has(host),
      vault,
    });
    const request = broker.request(sshInput());
    const pending = broker.provide(
      request.id,
      { password: CANARY },
      { retention: "saved", saveName: "gated_pw" },
    );
    expect(() => broker.decline(request.id)).toThrow(
      "secret request is being provided",
    );
    broker.lock();
    release();
    const error = await rejectedWith(pending);
    expect(error.code).toBe(3);
    const view = broker.status(request.id, "agent-one");
    expect(view.state).toBe("pending");
    expect(view.ref).toBeUndefined();
    expect(broker.history().map((item) => item.action)).toEqual(["requested"]);
  });
});
