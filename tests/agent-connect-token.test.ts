import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAgentConfig,
  type AgentKind,
  type ConfigChange,
  PLANNING_TOKEN,
  planAgentConfig,
  storeClientToken,
} from "../src/broker/onboard";
import { type ConnectDeps, connectAgent } from "../src/cli/agent-connect";

const REAL = "hct_real0123456789abcdef";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "homectl-connect-"));
}

// Real planner and applier against a temp HOME; only the broker calls are stubbed.
function depsFor(home: string, token = REAL): ConnectDeps {
  return {
    list: async () => [],
    create: async () => ({ token }),
    rotate: async () => ({ token }),
    plan: (kind: AgentKind, t: string) => planAgentConfig(kind, t, home),
    apply: applyAgentConfig,
    storeToken: (t) => storeClientToken(t, join(home, "client-token")),
    whoami: async () => "agent-host",
    confirm: async () => true,
    note: () => {},
    setupPrompt: () => "PROMPT",
    hostName: "host",
  };
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

describe("agent connect writes the real token, never the placeholder", () => {
  test("claude: settings.json holds the real key and no placeholder", async () => {
    const home = await tempHome();
    try {
      const result = await connectAgent(depsFor(home), {
        kind: "claude",
        hosts: [],
        name: "laptop",
      });
      expect(result.applied).toBe(true);
      const settings = await readFile(
        join(home, ".claude", "settings.json"),
        "utf8",
      );
      expect(JSON.parse(settings).env.HOMECTL_TOKEN).toBe(REAL);
      expect(settings).not.toContain(PLANNING_TOKEN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("codex: config.toml holds the real key and no placeholder", async () => {
    const home = await tempHome();
    try {
      await connectAgent(depsFor(home), {
        kind: "codex",
        hosts: [],
        name: "cli",
      });
      const toml = await readFile(join(home, ".codex", "config.toml"), "utf8");
      expect(toml).toContain(`HOMECTL_TOKEN = "${REAL}"`);
      expect(toml).not.toContain(PLANNING_TOKEN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("other: the private token file holds the real key and no placeholder", async () => {
    const home = await tempHome();
    try {
      await connectAgent(depsFor(home), {
        kind: "other",
        hosts: [],
        name: "tool",
      });
      const stored = await readFile(
        join(home, ".config", "homectl", "client-token"),
        "utf8",
      );
      expect(stored.trim()).toBe(REAL);
      expect(stored).not.toContain(PLANNING_TOKEN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rotate: the existing claude config gets the new real key", async () => {
    const home = await tempHome();
    try {
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ env: { HOMECTL_TOKEN: "hct_old" } }),
      );
      await connectAgent(
        {
          ...depsFor(home, "hct_rotated_new"),
          list: async () => [{ id: "claude" }],
        },
        { kind: "claude", hosts: [], client: "claude" },
      );
      const settings = await readFile(
        join(home, ".claude", "settings.json"),
        "utf8",
      );
      expect(JSON.parse(settings).env.HOMECTL_TOKEN).toBe("hct_rotated_new");
      expect(settings).not.toContain(PLANNING_TOKEN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a file that changed after the preview is refused and left alone", async () => {
    const home = await tempHome();
    try {
      const deps = depsFor(home);
      let planned = 0;
      const plan = deps.plan;
      deps.plan = async (kind, token) => {
        planned += 1;
        // The owner saw the preview; someone edits the file before the apply.
        if (planned === 2) {
          await mkdir(join(home, ".claude"), { recursive: true });
          await writeFile(
            join(home, ".claude", "settings.json"),
            JSON.stringify({ env: { OTHER: "1" } }),
          );
        }
        return plan(kind, token);
      };
      await expect(
        connectAgent(deps, { kind: "claude", hosts: [], name: "laptop" }),
      ).rejects.toThrow(
        /config could not be written|changed since the preview/,
      );
      const settings = await readOrEmpty(
        join(home, ".claude", "settings.json"),
      );
      expect(settings).not.toContain(REAL);
      expect(settings).not.toContain(PLANNING_TOKEN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("applyAgentConfig refuses any change that still holds the placeholder", async () => {
    const home = await tempHome();
    try {
      const [change] = await planAgentConfig("codex", PLANNING_TOKEN, home);
      const placeholder = change as ConfigChange;
      expect(placeholder.after).toContain(PLANNING_TOKEN);
      await expect(
        applyAgentConfig(placeholder, PLANNING_TOKEN),
      ).rejects.toThrow("Refusing to write a placeholder token");
      await expect(
        readOrEmpty(join(home, ".codex", "config.toml")),
      ).resolves.toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
