import { describe, expect, test } from "bun:test";
import type { SecretDestination } from "../src/core/contracts";
import {
  type BrokerRequestView,
  canaryLeaks,
  SecretBroker,
  type SecretRequestInput,
  type SecretUseOptions,
  type VaultPort,
} from "../src/secrets";
import { HomectlError } from "../src/types";

// Canary only. Never a real credential.
const CANARY = "CANARY-homectl-release-4Lp2-do-not-leak";
const KNOWN_HOSTS = new Set(["ext-host-01", "ext-host-02"]);

function memoryVault(): VaultPort & {
  store: Map<string, Record<string, string>>;
} {
  const store = new Map<string, Record<string, string>>();
  let counter = 0;
  return {
    store,
    async save(_name, values) {
      counter += 1;
      const id = `vault-${counter}`;
      store.set(id, { ...values });
      return id;
    },
    async load(secretId) {
      const found = store.get(secretId);
      return found ? { ...found } : undefined;
    },
  };
}

function setup() {
  const now = 2_000_000;
  let counter = 0;
  const vault = memoryVault();
  const broker = new SecretBroker({
    now: () => now,
    knownHost: (host) => KNOWN_HOSTS.has(host),
    vault,
    random: (bytes) => {
      counter += 1;
      return Uint8Array.from(
        { length: bytes },
        (_, i) => (counter * 13 + i * 5) & 0xff,
      );
    },
  });
  return { broker, vault };
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

const TARGET: SecretUseOptions = {
  client: "agent-one",
  task: "task-1",
  destination: { kind: "ssh-stdin", host: "ext-host-01", argv: ["chpasswd"] },
};

function refIn(view: BrokerRequestView): string {
  if (!view.ref) throw new Error("expected a reference");
  return view.ref;
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

async function provideEphemeral(
  broker: SecretBroker,
  input: SecretRequestInput = sshInput(),
) {
  const request = broker.request(input);
  const view = await broker.provide(
    request.id,
    { password: CANARY },
    { retention: "ephemeral" },
  );
  return { requestId: request.id, ref: refIn(view) };
}

describe("secret broker: use is bound to requester and destination", () => {
  test("a different client is refused with a fixed message", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    const error = await rejectedWith(
      broker.use(ref, { ...TARGET, client: "agent-two" }),
    );
    expect(error.code).toBe(3);
    expect(error.message).toBe("requester does not match the secret request");
  });

  test("a different task is refused as a requester mismatch", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    const error = await rejectedWith(
      broker.use(ref, { ...TARGET, task: "task-9" }),
    );
    expect(error.message).toBe("requester does not match the secret request");
  });

  test("a different destination is refused: other host, other argv, other kind", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    const wrongHost = await rejectedWith(
      broker.use(ref, {
        ...TARGET,
        destination: {
          kind: "ssh-stdin",
          host: "ext-host-02",
          argv: ["chpasswd"],
        },
      }),
    );
    expect(wrongHost.message).toBe(
      "destination does not match the secret request",
    );
    const wrongArgv = await rejectedWith(
      broker.use(ref, {
        ...TARGET,
        destination: {
          kind: "ssh-stdin",
          host: "ext-host-01",
          argv: ["chpasswd", "-e"],
        },
      }),
    );
    expect(wrongArgv.message).toBe(
      "destination does not match the secret request",
    );
    const wrongKind = await rejectedWith(
      broker.use(ref, { ...TARGET, destination: { kind: "vault-only" } }),
    );
    expect(wrongKind.code).toBe(3);
  });

  test("an unknown host in the use destination is a refusal, not a value", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    const error = await rejectedWith(
      broker.use(ref, {
        ...TARGET,
        destination: {
          kind: "ssh-stdin",
          host: "not-inventoried",
          argv: ["chpasswd"],
        },
      }),
    );
    expect(error.message).toBe("destination does not match the secret request");
  });

  test("replay after revoke is rejected and the error never includes the value", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    expect((await broker.use(ref, TARGET)).password).toBe(CANARY);
    broker.revoke(ref);
    const error = await rejectedWith(broker.use(ref, TARGET));
    expect(error.message).toBe("secret reference is not usable");
    expect(canaryLeaks([error.message], [CANARY])).toEqual([]);
  });

  test("an unknown reference is refused with the same fixed message", async () => {
    const { broker } = setup();
    const error = await rejectedWith(
      broker.use("sref_AAAAAAAAAAAAAAAAAAAAAAAA", TARGET),
    );
    expect(error.code).toBe(3);
    expect(error.message).toBe("secret reference is not usable");
  });
});

describe("secret broker: raw handoff refusals and acceptance", () => {
  const acknowledged = {
    client: "agent-one",
    stepUp: true,
    warningAcknowledged: true,
  };

  test("refused without step-up or without the acknowledged warning", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    const noStepUp = await rejectedWith(
      broker.rawHandoff(ref, { ...acknowledged, stepUp: false }),
    );
    expect(noStepUp.code).toBe(3);
    const noAck = await rejectedWith(
      broker.rawHandoff(ref, { ...acknowledged, warningAcknowledged: false }),
    );
    expect(noAck.code).toBe(3);
  });

  test("refused for admin requests and for ssh-key fields", async () => {
    const { broker } = setup();
    const admin = await provideEphemeral(broker, sshInput({ admin: true }));
    const adminError = await rejectedWith(
      broker.rawHandoff(admin.ref, acknowledged),
    );
    expect(adminError.message).toBe(
      "raw handoff is refused for admin requests",
    );

    const key = await provideEphemeral(
      broker,
      sshInput({
        fields: [{ name: "password", kind: "ssh-key" }],
        task: "task-key",
      }),
    );
    const keyError = await rejectedWith(
      broker.rawHandoff(key.ref, { ...acknowledged }),
    );
    expect(keyError.message).toBe("raw handoff is refused for ssh-key fields");
  });

  test("refused for a different client", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    const error = await rejectedWith(
      broker.rawHandoff(ref, { ...acknowledged, client: "agent-two" }),
    );
    expect(error.message).toBe("requester does not match the secret request");
  });

  test("accepted with step-up and acknowledgement; recorded without the value", async () => {
    const { broker } = setup();
    const { ref } = await provideEphemeral(broker);
    const values = await broker.rawHandoff(ref, acknowledged);
    expect(values.password).toBe(CANARY);
    const actions = broker.history().map((item) => item.action);
    expect(actions[actions.length - 1]).toBe("raw-handoff");
    expect(canaryLeaks([JSON.stringify(broker.history())], [CANARY])).toEqual(
      [],
    );
  });
});

describe("secret broker: saved secrets reused within a grant", () => {
  async function savedSecret() {
    const { broker, vault } = setup();
    const request = broker.request(sshInput());
    const view = await broker.provide(
      request.id,
      { password: CANARY },
      { retention: "saved", saveName: "shared_pw" },
    );
    const secretId = [...vault.store.keys()][0];
    if (!secretId) throw new Error("expected a saved secret");
    return { broker, ref: refIn(view), secretId };
  }

  const otherDestination: SecretDestination = {
    kind: "ssh-stdin",
    host: "ext-host-01",
    argv: ["chpasswd"],
  };

  test("a granted client uses the saved secret without a new request", async () => {
    const { broker, secretId } = await savedSecret();
    broker.grantUse(secretId, {
      clients: ["agent-two"],
      hosts: ["ext-host-01"],
    });
    const before = broker
      .history()
      .filter((item) => item.action === "requested").length;
    const values = await broker.useSaved(secretId, {
      client: "agent-two",
      destination: otherDestination,
    });
    expect(values.password).toBe(CANARY);
    const after = broker
      .history()
      .filter((item) => item.action === "requested").length;
    expect(after).toBe(before);
  });

  test("the existing reference also works for a granted client and host", async () => {
    const { broker, ref, secretId } = await savedSecret();
    broker.grantUse(secretId, {
      clients: ["agent-two"],
      hosts: ["ext-host-01"],
    });
    const values = await broker.use(ref, {
      client: "agent-two",
      destination: otherDestination,
    });
    expect(values.password).toBe(CANARY);
  });

  test("outside the grant scope the use is refused: client, host, or destination kind", async () => {
    const { broker, secretId } = await savedSecret();
    broker.grantUse(secretId, {
      clients: ["agent-two"],
      hosts: ["ext-host-01"],
    });
    const wrongClient = await rejectedWith(
      broker.useSaved(secretId, {
        client: "agent-three",
        destination: otherDestination,
      }),
    );
    expect(wrongClient.message).toBe("no saved-secret grant covers this use");
    const wrongHost = await rejectedWith(
      broker.useSaved(secretId, {
        client: "agent-two",
        destination: {
          kind: "ssh-stdin",
          host: "ext-host-02",
          argv: ["chpasswd"],
        },
      }),
    );
    expect(wrongHost.code).toBe(3);
    const wrongKind = await rejectedWith(
      broker.useSaved(secretId, {
        client: "agent-two",
        destination: {
          kind: "http-header",
          url: "https://ext-host-01.example/",
          header: "X-Key",
        },
      }),
    );
    expect(wrongKind.code).toBe(3);
  });

  test("a secret without any grant cannot be used by any client", async () => {
    const { broker, secretId } = await savedSecret();
    const error = await rejectedWith(
      broker.useSaved(secretId, {
        client: "agent-two",
        destination: otherDestination,
      }),
    );
    expect(error.code).toBe(3);
  });

  test("revoking the reference kills the saved secret's grants for good", async () => {
    const { broker, ref, secretId } = await savedSecret();
    broker.grantUse(secretId, {
      clients: ["agent-two"],
      hosts: ["ext-host-01"],
    });
    broker.revoke(ref);
    const afterRevoke = await rejectedWith(
      broker.useSaved(secretId, {
        client: "agent-two",
        destination: otherDestination,
      }),
    );
    expect(afterRevoke.code).toBe(3);
    expect(() =>
      broker.grantUse(secretId, {
        clients: ["agent-two"],
        hosts: ["ext-host-01"],
      }),
    ).toThrow("secret reference is not usable");
  });

  test("grant scope is validated: non-empty lists, valid clients, known hosts", () => {
    const { broker } = setup();
    const bad = [
      { clients: [], hosts: ["ext-host-01"] },
      { clients: ["owner"], hosts: ["ext-host-01"] },
      { clients: ["agent-two"], hosts: ["unknown-host"] },
    ];
    for (const scope of bad) {
      try {
        broker.grantUse("vault-1", scope);
        throw new Error("expected grantUse to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(HomectlError);
        expect((error as HomectlError).code).toBe(2);
      }
    }
  });
});
