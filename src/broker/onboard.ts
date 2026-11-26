// Agent onboarding (homelab #21 §4 Onboarding, matrix A2). Each agent install
// gets its own client identity and token. The token is written privately into
// that agent's own configuration (never into chat or a prompt). The owner sees
// the exact config change before it is applied; unsupported layouts fall back
// to manual steps instead of guessing. The homectl MCP server is registered in
// the same reviewed step; it holds no token and reads the client-token file.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicReplace, protect } from "../platform";
import { HomectlError } from "../types";
import { clientTokenPath } from "./paths";

export type AgentKind = "codex" | "claude" | "other";

// Used only to build the preview (the token is masked there). It is never a
// real key: applyAgentConfig refuses to write any config that still holds it.
export const PLANNING_TOKEN = "planning-placeholder";

const BEGIN = "# >>> homectl (managed; edit with home-ctl agent connect)";
const END = "# <<< homectl";
// The MCP server every agent starts: `home-ctl mcp` over stdio.
const MCP_COMMAND = "home-ctl";
const MCP_ARGS = ["mcp"];

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePrivate(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${createHash("sha256").update(text).digest("hex").slice(0, 8)}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await atomicReplace(temp, path);
  await protect(path);
}

export async function storeClientToken(
  token: string,
  path = clientTokenPath(),
) {
  await writePrivate(path, `${token}\n`);
}

export interface ConfigChange {
  agent: AgentKind;
  path: string;
  supported: boolean;
  before?: string;
  after?: string;
  // Lines for the owner to review; the token is masked.
  diff: string[];
  manual?: string[];
}

const mask = (text: string, token: string) =>
  token ? text.split(token).join("hct_••••••••") : text;

function lineDiff(before: string, after: string, token: string): string[] {
  const a = new Set(before.split("\n"));
  const b = new Set(after.split("\n"));
  return [
    ...before
      .split("\n")
      .filter((l) => !b.has(l))
      .map((l) => `- ${l}`),
    ...after
      .split("\n")
      .filter((l) => !a.has(l))
      .map((l) => `+ ${mask(l, token)}`),
  ];
}

// Claude Code: user settings JSON, `env` map.
function claudeChange(
  path: string,
  before: string | undefined,
  token: string,
): ConfigChange {
  let data: Record<string, unknown> = {};
  if (before !== undefined) {
    try {
      data = JSON.parse(before) as Record<string, unknown>;
    } catch {
      return {
        agent: "claude",
        path,
        supported: false,
        diff: [],
        manual: [`${path} is not valid JSON; fix it, then run this again.`],
      };
    }
  }
  const env =
    data.env && typeof data.env === "object"
      ? (data.env as Record<string, string>)
      : {};
  const after = `${JSON.stringify({ ...data, env: { ...env, HOMECTL_TOKEN: token } }, null, 2)}\n`;
  return {
    agent: "claude",
    path,
    supported: true,
    ...(before === undefined ? {} : { before }),
    after,
    diff: lineDiff(before ?? "", after, token),
  };
}

const isOurClaudeMcp = (entry: unknown) =>
  !!entry &&
  typeof entry === "object" &&
  (entry as { command?: unknown }).command === MCP_COMMAND &&
  JSON.stringify((entry as { args?: unknown }).args) ===
    JSON.stringify(MCP_ARGS);

// Claude Code keeps user-scope MCP servers in ~/.claude.json under mcpServers
// (not in settings.json). An existing "homectl" entry is replaced only when it
// is our own; anything else is left for the owner to resolve.
function claudeMcpChange(
  path: string,
  before: string | undefined,
): ConfigChange {
  let data: Record<string, unknown> = {};
  if (before !== undefined) {
    try {
      data = JSON.parse(before) as Record<string, unknown>;
    } catch {
      return {
        agent: "claude",
        path,
        supported: false,
        diff: [],
        manual: [`${path} is not valid JSON; fix it, then run this again.`],
      };
    }
  }
  const servers =
    data.mcpServers && typeof data.mcpServers === "object"
      ? (data.mcpServers as Record<string, unknown>)
      : {};
  if (servers.homectl !== undefined && !isOurClaudeMcp(servers.homectl))
    return {
      agent: "claude",
      path,
      supported: false,
      diff: [],
      manual: [
        `${path} already defines an MCP server named "homectl".`,
        `Rename or remove it, then run this again, or add { "command": "${MCP_COMMAND}", "args": ${JSON.stringify(MCP_ARGS)} } to mcpServers yourself.`,
      ],
    };
  const entry = { type: "stdio", command: MCP_COMMAND, args: MCP_ARGS };
  const after = `${JSON.stringify({ ...data, mcpServers: { ...servers, homectl: entry } }, null, 2)}\n`;
  return {
    agent: "claude",
    path,
    supported: true,
    ...(before === undefined ? {} : { before }),
    after,
    diff: lineDiff(before ?? "", after, ""),
  };
}

// Codex: config.toml. We manage one marked block with the token for the shell
// and the MCP server table. We refuse to touch a file that already configures
// either one outside that block.
function codexChange(
  path: string,
  before: string | undefined,
  token: string,
): ConfigChange {
  const text = before ?? "";
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const outside =
    start >= 0 && end > start
      ? text.slice(0, start) + text.slice(end + END.length)
      : text;
  if (/^\s*\[shell_environment_policy/m.test(outside))
    return {
      agent: "codex",
      path,
      supported: false,
      diff: [],
      manual: [
        `${path} already configures shell_environment_policy.`,
        "Add HOMECTL_TOKEN to its `set` table yourself, using the token stored in ~/.config/homectl/client-token.",
      ],
    };
  if (/^\s*\[mcp_servers\.homectl\]/m.test(outside))
    return {
      agent: "codex",
      path,
      supported: false,
      diff: [],
      manual: [
        `${path} already defines [mcp_servers.homectl].`,
        `Rename or remove it, then run this again, or add command = "${MCP_COMMAND}" and args = ${JSON.stringify(MCP_ARGS)} to it yourself.`,
      ],
    };
  const block = [
    BEGIN,
    "[shell_environment_policy.set]",
    `HOMECTL_TOKEN = "${token}"`,
    "",
    "[mcp_servers.homectl]",
    `command = "${MCP_COMMAND}"`,
    `args = ${JSON.stringify(MCP_ARGS)}`,
    END,
  ].join("\n");
  const after =
    start >= 0 && end > start
      ? text.slice(0, start) + block + text.slice(end + END.length)
      : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`;
  return {
    agent: "codex",
    path,
    supported: true,
    ...(before === undefined ? {} : { before }),
    after,
    diff: lineDiff(text, after, token),
  };
}

export function agentConfigPath(agent: AgentKind, home = homedir()): string {
  if (agent === "claude") return join(home, ".claude", "settings.json");
  if (agent === "codex") return join(home, ".codex", "config.toml");
  return clientTokenPath(home);
}

export function claudeMcpPath(home = homedir()): string {
  return join(home, ".claude.json");
}

// Every reviewed change for one agent kind. Apply them all or none: if any is
// unsupported, the caller falls back to manual steps.
export async function planAgentConfig(
  agent: AgentKind,
  token: string,
  home = homedir(),
): Promise<ConfigChange[]> {
  const path = agentConfigPath(agent, home);
  if (agent === "other")
    return [
      {
        agent,
        path,
        supported: true,
        diff: [`+ ${path} (private token file, mode 0600)`],
      },
    ];
  const before = await readText(path);
  if (agent === "codex") return [codexChange(path, before, token)];
  const mcpPath = claudeMcpPath(home);
  return [
    claudeChange(path, before, token),
    claudeMcpChange(mcpPath, await readText(mcpPath)),
  ];
}

// Applies a reviewed change. Refuses if the file changed since planning.
export async function applyAgentConfig(change: ConfigChange, token: string) {
  if (!change.supported)
    throw new HomectlError(3, "This configuration needs manual setup");
  if (token === PLANNING_TOKEN || change.after?.includes(PLANNING_TOKEN))
    throw new HomectlError(
      3,
      "Refusing to write a placeholder token. Run agent connect again.",
    );
  if (change.agent === "other") {
    await storeClientToken(token, change.path);
    return;
  }
  const current = await readText(change.path);
  if (current !== change.before)
    throw new HomectlError(
      3,
      `${change.path} changed since the preview; run the command again`,
    );
  if (current !== undefined)
    await writePrivate(`${change.path}.homectl-backup`, current);
  await writePrivate(change.path, change.after ?? "");
}

// Copyable instructions for any agent. Contains no secret.
export function setupPrompt(agent: AgentKind): string {
  return [
    "You can manage the user's machines through homectl.",
    "If the homectl MCP tools are available, use them: hosts, exec, wait, status, list, cancel, task_open, task_close and the secret_* tools.",
    "Otherwise run `home-ctl hosts` to see machines and `home-ctl exec <host> -- <argv>` to run commands.",
    "Safe inspection runs right away. Changes wait for the owner's approval in the homectl panel:",
    "when a result says it is waiting, tell the user, then wait for that operation.",
    "Never ask the user for passwords, tokens or keys in chat; request them with secret_request.",
    "homectl never retries a command for you: read the result and decide what to do next.",
    agent === "other"
      ? "Your homectl identity token is in ~/.config/homectl/client-token; do not print it. The MCP server starts with the command `home-ctl` and the argument `mcp`."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
