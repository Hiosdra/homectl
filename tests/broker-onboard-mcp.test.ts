// Agent onboarding registers the homectl MCP server (homelab #21, A2) in the
// same reviewed step as the token: user-scope Claude MCP servers live in
// ~/.claude.json, Codex's in ~/.codex/config.toml. Applying keeps the owner's
// other settings, writes a backup, refuses a foreign "homectl" entry, and never
// shows the token in the diff.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAgentConfig,
  planAgentConfig,
  setupPrompt,
} from "../src/broker/onboard";

const TOKEN = "hct_TESTTOKEN0123456789";
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "homectl-onboard-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("claude: the MCP server joins ~/.claude.json, other settings survive, a backup is kept", async () => {
  await writeFile(
    join(home, ".claude.json"),
    `${JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }, null, 2)}\n`,
  );
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify({ theme: "dark" }, null, 2)}\n`,
  );

  const changes = await planAgentConfig("claude", TOKEN, home);
  expect(changes.map((c) => c.path)).toEqual([
    join(home, ".claude", "settings.json"),
    join(home, ".claude.json"),
  ]);
  expect(changes.every((c) => c.supported)).toBe(true);
  const mcp = changes[1];
  expect(mcp?.diff.join("\n")).toContain('"homectl"');
  // The token never reaches the owner-facing diff.
  for (const change of changes)
    expect(change.diff.join("\n")).not.toContain(TOKEN);

  for (const change of changes) await applyAgentConfig(change, TOKEN);
  const claude = JSON.parse(
    await readFile(join(home, ".claude.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(claude.numStartups).toBe(3);
  expect(claude.mcpServers).toEqual({
    other: { command: "x" },
    homectl: { type: "stdio", command: "home-ctl", args: ["mcp"] },
  });
  const backup = await readFile(
    join(home, ".claude.json.homectl-backup"),
    "utf8",
  );
  expect(JSON.parse(backup)).toEqual({
    numStartups: 3,
    mcpServers: { other: { command: "x" } },
  });

  // Re-planning after apply shows no MCP change: the registration is idempotent.
  const again = await planAgentConfig("claude", TOKEN, home);
  expect(again[1]?.supported).toBe(true);
  expect(again[1]?.diff).toEqual([]);
});

test("claude: a foreign 'homectl' MCP server is refused, with the reason and a manual step", async () => {
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { homectl: { command: "other-tool" } } }),
  );
  const [, mcp] = await planAgentConfig("claude", TOKEN, home);
  expect(mcp?.supported).toBe(false);
  expect(mcp?.manual?.join("\n")).toContain(
    'already defines an MCP server named "homectl"',
  );
  if (!mcp) throw new Error("Expected a Claude MCP configuration plan");
  await expect(applyAgentConfig(mcp, TOKEN)).rejects.toThrow(
    "needs manual setup",
  );
});

test("claude: an unreadable ~/.claude.json is refused rather than overwritten", async () => {
  await writeFile(join(home, ".claude.json"), "{not json");
  const [, mcp] = await planAgentConfig("claude", TOKEN, home);
  expect(mcp?.supported).toBe(false);
  expect(await readFile(join(home, ".claude.json"), "utf8")).toBe("{not json");
});

test("codex: the managed block carries the token and the MCP table, idempotently", async () => {
  const [codex] = await planAgentConfig("codex", TOKEN, home);
  expect(codex?.supported).toBe(true);
  expect(codex?.after).toContain("[mcp_servers.homectl]");
  expect(codex?.after).toContain('command = "home-ctl"');
  expect(codex?.after).toContain('args = ["mcp"]');
  expect(codex?.diff.join("\n")).not.toContain(TOKEN);

  if (!codex) throw new Error("Expected a Codex configuration plan");
  await applyAgentConfig(codex, TOKEN);
  const [again] = await planAgentConfig("codex", TOKEN, home);
  expect(again?.after).toBe(codex?.after);
  expect(again?.diff).toEqual([]);
});

test("codex: a hand-written [mcp_servers.homectl] outside the block is refused", async () => {
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "config.toml"),
    '[mcp_servers.homectl]\ncommand = "something-else"\n',
  );
  const [codex] = await planAgentConfig("codex", TOKEN, home);
  expect(codex?.supported).toBe(false);
  expect(codex?.manual?.join("\n")).toContain("[mcp_servers.homectl]");
});

test("apply refuses when the file changed since the preview", async () => {
  const [codex] = await planAgentConfig("codex", TOKEN, home);
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), "# changed by hand\n");
  if (!codex) throw new Error("Expected a Codex configuration plan");
  await expect(applyAgentConfig(codex, TOKEN)).rejects.toThrow(
    "changed since the preview",
  );
});

test("the setup prompt names the MCP tools and never contains a token", () => {
  for (const agent of ["codex", "claude", "other"] as const) {
    const prompt = setupPrompt(agent);
    expect(prompt).toContain("secret_request");
    expect(prompt).not.toContain("hct_");
  }
  expect(setupPrompt("other")).toContain("`mcp`");
});
