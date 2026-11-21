import { describe, expect, test } from "bun:test";
import type { ConfigChange } from "../src/broker/onboard";
import {
  type ConnectDeps,
  connectAgent,
  describeConnect,
  freeClientId,
  normalizeClientId,
} from "../src/cli/agent-connect";
import { HomectlError } from "../src/types";

function change(overrides: Partial<ConfigChange> = {}): ConfigChange {
  return {
    agent: "claude",
    path: "/home/owner/.claude/settings.json",
    supported: true,
    diff: ["+ env.HOMECTL_TOKEN = ****"],
    ...overrides,
  } as ConfigChange;
}

interface Recorder {
  calls: string[];
  deps: ConnectDeps;
}

// Stubs every broker and file action and records the order they run in.
function recorder(
  options: {
    clients?: string[];
    answer?: boolean;
    supported?: boolean;
    applyFails?: boolean;
  } = {},
): Recorder {
  const calls: string[] = [];
  const deps: ConnectDeps = {
    list: async () => {
      calls.push("list");
      return (options.clients ?? []).map((id) => ({ id }));
    },
    create: async (input) => {
      calls.push(`create:${input.id}`);
      return { token: "token-new" };
    },
    rotate: async (id) => {
      calls.push(`rotate:${id}`);
      return { token: "token-rotated" };
    },
    plan: async () => {
      calls.push("plan");
      return [
        change({
          supported: options.supported ?? true,
          ...(options.supported === false
            ? { manual: ["Add HOMECTL_TOKEN to your agent by hand."] }
            : {}),
        }),
      ];
    },
    apply: async () => {
      calls.push("apply");
      if (options.applyFails) throw new Error("disk full");
    },
    storeToken: async (token) => {
      calls.push(`store:${token}`);
    },
    whoami: async (token) => {
      calls.push(`whoami:${token}`);
      return "claude-host";
    },
    confirm: async () => {
      calls.push("confirm");
      return options.answer ?? true;
    },
    note: () => {},
    setupPrompt: () => "PROMPT",
    hostName: "host",
  };
  return { calls, deps };
}

describe("agent connect: plan before anything is created", () => {
  test("a 'no' at the prompt creates nothing and changes nothing", async () => {
    const r = recorder({ answer: false });
    await expect(
      connectAgent(r.deps, { kind: "claude", hosts: ["lab"] }),
    ).rejects.toThrow("Cancelled. Nothing was created or changed.");
    expect(r.calls).toEqual(["list", "plan", "confirm"]);
  });

  test("the create call happens only after the owner says yes", async () => {
    const r = recorder({ answer: true });
    const result = await connectAgent(r.deps, {
      kind: "claude",
      hosts: ["lab"],
    });
    expect(r.calls.indexOf("confirm")).toBeLessThan(
      r.calls.indexOf("create:claude-host"),
    );
    expect(result).toMatchObject({ id: "claude-host", applied: true });
  });

  test("without a terminal (confirm is false) nothing is created", async () => {
    const r = recorder({ answer: false });
    await expect(
      connectAgent(r.deps, { kind: "codex", hosts: [] }),
    ).rejects.toBeInstanceOf(HomectlError);
    expect(r.calls.some((c) => c.startsWith("create"))).toBe(false);
  });

  test("a failed config write says the assistant exists and how to remove it", async () => {
    const r = recorder({ applyFails: true });
    await expect(
      connectAgent(r.deps, { kind: "claude", hosts: [] }),
    ).rejects.toThrow(
      /was created, but its config could not be written: disk full/,
    );
  });
});

describe("agent connect: ids", () => {
  test("a taken default id gets the next free suffix, and the owner is told", async () => {
    const r = recorder({ clients: ["claude-host"] });
    const result = await connectAgent(r.deps, { kind: "claude", hosts: [] });
    expect(r.calls).toContain("create:claude-host-2");
    expect(result.idNote).toContain('"claude-host-2"');
  });

  test("a removed (revoked) id is treated as taken, so it is not reused", async () => {
    // The client list includes revoked clients.
    const r = recorder({ clients: ["claude-host", "claude-host-2"] });
    await connectAgent(r.deps, { kind: "claude", hosts: [] });
    expect(r.calls).toContain("create:claude-host-3");
    expect(r.calls.some((c) => c === "create:claude-host")).toBe(false);
  });

  test("an explicit --name that is taken is refused with a suggestion, before the prompt", async () => {
    const r = recorder({ clients: ["laptop"] });
    await expect(
      connectAgent(r.deps, { kind: "claude", hosts: [], name: "laptop" }),
    ).rejects.toThrow(/already exists or was removed.*--name laptop-2/);
    expect(r.calls).toEqual(["list"]);
  });

  test("freeClientId counts up and keeps the id within 63 characters", () => {
    expect(freeClientId("claude", new Set())).toBe("claude");
    expect(freeClientId("claude", new Set(["claude", "claude-2"]))).toBe(
      "claude-3",
    );
    const long = "a".repeat(63);
    const suffixed = freeClientId(long, new Set([long]));
    expect(suffixed.length).toBeLessThanOrEqual(63);
    expect(suffixed.endsWith("-2")).toBe(true);
  });

  test("normalizeClientId lowercases, replaces odd characters and starts with a letter", () => {
    expect(normalizeClientId("9 Laptop_Work")).toBe("laptop-work");
  });
});

describe("agent connect --client", () => {
  test("rotates the named assistant, never creates one", async () => {
    const r = recorder({ clients: ["claude"] });
    const result = await connectAgent(r.deps, {
      kind: "claude",
      hosts: [],
      client: "claude",
    });
    expect(r.calls).toContain("rotate:claude");
    expect(r.calls.some((c) => c.startsWith("create"))).toBe(false);
    expect(r.calls).toContain("store:token-rotated");
    expect(result).toMatchObject({ id: "claude-host", rotated: true });
  });

  test("the new key, not the old one, is what gets written and verified", async () => {
    const r = recorder({ clients: ["claude"] });
    await connectAgent(r.deps, { kind: "claude", hosts: [], client: "claude" });
    expect(r.calls).toContain("whoami:token-rotated");
    expect(r.calls).not.toContain("whoami:token-new");
  });

  test("an unknown id is refused before the prompt and before any rotation", async () => {
    const r = recorder({ clients: ["claude"] });
    await expect(
      connectAgent(r.deps, { kind: "claude", hosts: [], client: "ghost" }),
    ).rejects.toThrow('No assistant named "ghost"');
    expect(r.calls).toEqual(["list"]);
  });

  test("the plan is shown before the rotation, and a 'no' keeps the old key", async () => {
    const r = recorder({ clients: ["claude"], answer: false });
    await expect(
      connectAgent(r.deps, { kind: "claude", hosts: [], client: "claude" }),
    ).rejects.toThrow("Cancelled");
    expect(r.calls.some((c) => c.startsWith("rotate"))).toBe(false);
  });
});

describe("agent connect: unsupported agent config", () => {
  test("gives the manual steps and the prompt, and stores the key", async () => {
    const r = recorder({ supported: false });
    const result = await connectAgent(r.deps, { kind: "codex", hosts: [] });
    expect(result).toMatchObject({ applied: false, prompt: "PROMPT" });
    expect(r.calls).toContain("store:token-new");
    expect(r.calls).not.toContain("confirm");
  });
});

describe("agent connect: output", () => {
  test("a rotation says the old key no longer works", () => {
    const text = describeConnect(
      { id: "claude", applied: true, rotated: true, paths: [] },
      "claude",
    );
    expect(text).toContain("with a new key. The old key no longer works.");
  });

  test("the id note is shown first", () => {
    const text = describeConnect(
      {
        id: "claude-2",
        applied: true,
        rotated: false,
        paths: [],
        idNote: '"claude" is already used',
      },
      "claude",
    );
    expect(text.split("\n")[0]).toBe('"claude" is already used');
  });
});
