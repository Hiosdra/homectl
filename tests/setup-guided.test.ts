import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFlow } from "../src/setup-flow";
import {
  chooseVaultPassword,
  type GuidedDeps,
  guidedSetup,
  isYes,
  VAULT_EXPLANATION,
} from "../src/setup-guided";
import { HomectlError } from "../src/types";

// Answers come from scripted lists, so no test waits on a terminal.
function scripted(answers: string[]) {
  const queue = [...answers];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("ran out of scripted answers");
    return next;
  };
}

function deps(overrides: Partial<GuidedDeps> = {}) {
  const lines: string[] = [];
  const calls: string[] = [];
  const base: GuidedDeps = {
    say: (line) => lines.push(line),
    ask: async (question) => {
      calls.push(`ask:${question}`);
      return "y";
    },
    askSecret: scripted(["correct horse battery", "correct horse battery"]),
    vaultExists: async () => false,
    vaultPath: "/state/homelab.kdbx",
    createVault: async (password) => {
      calls.push(`createVault:${password}`);
      return undefined;
    },
    start: async () => {
      calls.push("start");
      return 0;
    },
    ...overrides,
  };
  return { deps: base, lines, calls };
}

describe("vault password in the guided setup", () => {
  test("a short password is refused and asked again", async () => {
    const lines: string[] = [];
    const password = await chooseVaultPassword({
      say: (line) => lines.push(line),
      askSecret: scripted([
        "short",
        "correct horse battery",
        "correct horse battery",
      ]),
    });
    expect(password).toBe("correct horse battery");
    expect(lines).toContain("Use at least 12 characters.");
  });

  test("two different answers are refused and asked again", async () => {
    const lines: string[] = [];
    const password = await chooseVaultPassword({
      say: (line) => lines.push(line),
      askSecret: scripted([
        "correct horse battery",
        "a different one here",
        "correct horse battery",
        "correct horse battery",
      ]),
    });
    expect(password).toBe("correct horse battery");
    expect(lines).toContain("The two passwords differ. Try again.");
  });

  test("the flow stops after five tries instead of looping", async () => {
    const answers = Array.from({ length: 5 }, () => "short");
    await expect(
      chooseVaultPassword({
        say: () => {},
        askSecret: scripted(answers),
      }),
    ).rejects.toBeInstanceOf(HomectlError);
  });
});

describe("guided setup steps", () => {
  test("the vault explanation is printed once, and before the password is asked", async () => {
    const { deps: d, lines } = deps();
    await guidedSetup(d);
    expect(lines.filter((line) => line === VAULT_EXPLANATION)).toHaveLength(1);
    expect(VAULT_EXPLANATION).toContain(
      "Its password is also your owner password",
    );
  });

  test("a new vault is created with the chosen password before the start question", async () => {
    const { deps: d, calls } = deps();
    const result = await guidedSetup(d);
    expect(result).toEqual({ vault: "created", started: true });
    expect(calls.indexOf("createVault:correct horse battery")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("ask:")),
    );
  });

  test("an existing vault is not recreated and its password is not asked again", async () => {
    const {
      deps: d,
      calls,
      lines,
    } = deps({
      vaultExists: async () => true,
      askSecret: async () => {
        throw new Error("must not ask for a password");
      },
    });
    const result = await guidedSetup(d);
    expect(result.vault).toBe("existing");
    expect(calls.some((c) => c.startsWith("createVault"))).toBe(false);
    expect(lines.join("\n")).toContain("already exists");
  });

  test("the start question defaults to yes: an empty answer starts homectl", async () => {
    const { deps: d, calls } = deps({ ask: async () => "" });
    expect((await guidedSetup(d)).started).toBe(true);
    expect(calls).toContain("start");
  });

  test("'n' does not start homectl and says how to start it later", async () => {
    const { deps: d, calls, lines } = deps({ ask: async () => "n" });
    const result = await guidedSetup(d);
    expect(result.started).toBe(false);
    expect(calls).not.toContain("start");
    expect(lines.join("\n")).toContain("Run home-ctl start");
  });

  test("the summary names the owner password once and the next step", async () => {
    const { deps: d, lines } = deps();
    await guidedSetup(d);
    const summary = lines.join("\n");
    expect(summary).toContain("Owner password: the vault password");
    expect(summary).toContain("3/4 Summary");
    expect(summary).toContain("4/4 Start");
  });
});

describe("yes or no at the start question", () => {
  test("empty, y and yes mean yes; anything else means no", () => {
    expect(isYes("")).toBe(true);
    expect(isYes("  ")).toBe(true);
    expect(isYes("y")).toBe(true);
    expect(isYes("YES")).toBe(true);
    expect(isYes("n")).toBe(false);
    expect(isYes("no")).toBe(false);
  });
});

describe("setupFlow interactive run, with the terminal stubbed", () => {
  test("creates the vault, then offers to start homectl", async () => {
    const home = await mkdtemp(join(tmpdir(), "homectl-setup-guided-"));
    const created: string[] = [];
    let started = 0;
    try {
      const result = await setupFlow({
        home,
        json: false,
        dryRun: false,
        installDeps: false,
        configureFirewall: false,
        interactive: true,
        addresses: [],
        ask: async (prompt) => {
          // Dependency install prompts are declined; the start question is yes.
          return prompt.startsWith("Start homectl") ? "" : "n";
        },
        askSecret: scripted(["correct horse battery", "correct horse battery"]),
        createVault: async (password) => {
          created.push(password);
          return undefined;
        },
        start: async () => {
          started += 1;
          return 0;
        },
      });
      expect(result.interactive).toBe(true);
      expect(result.guided).toEqual({ vault: "created", started: true });
      expect(created).toEqual(["correct horse battery"]);
      expect(started).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
