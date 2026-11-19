// Agent onboarding (homelab #21 §4 Onboarding, matrix A2). Each agent install
// gets its own client identity and token. The token is written privately into
// that agent's own configuration (never into chat or a prompt). The owner sees
// the exact config change before it is applied; unsupported layouts fall back
// to manual steps instead of guessing.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicReplace, protect } from "../platform";
import { HomectlError } from "../types";
import { clientTokenPath } from "./paths";

export type AgentKind = "codex" | "claude" | "other";

const BEGIN = "# >>> homectl (managed; edit with home-ctl agent connect)";
const END = "# <<< homectl";

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
  text.split(token).join("hct_••••••••");

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

// Codex: config.toml. We manage one marked block and refuse to touch a file
// that already configures shell_environment_policy elsewhere.
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
  const block = `${BEGIN}\n[shell_environment_policy.set]\nHOMECTL_TOKEN = "${token}"\n${END}`;
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

export async function planAgentConfig(
  agent: AgentKind,
  token: string,
  home = homedir(),
): Promise<ConfigChange> {
  const path = agentConfigPath(agent, home);
  if (agent === "other")
    return {
      agent,
      path,
      supported: true,
      diff: [`+ ${path} (private token file, mode 0600)`],
    };
  const before = await readText(path);
  return agent === "claude"
    ? claudeChange(path, before, token)
    : codexChange(path, before, token);
}

// Applies a reviewed change. Refuses if the file changed since planning.
export async function applyAgentConfig(change: ConfigChange, token: string) {
  if (!change.supported)
    throw new HomectlError(3, "This configuration needs manual setup");
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
    "Run `home-ctl hosts` to see machines, `home-ctl exec <host> -- <argv>` to run commands.",
    "Safe inspection runs right away. Changes wait for the owner's approval in the homectl panel:",
    "when a command reports it is waiting, tell the user, then run `home-ctl wait <operation>`.",
    "Never ask the user for passwords or keys in chat; use `home-ctl secret request` instead.",
    "homectl never retries a command for you: read the result and decide what to do next.",
    agent === "other"
      ? "Your homectl identity token is in ~/.config/homectl/client-token; do not print it."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
