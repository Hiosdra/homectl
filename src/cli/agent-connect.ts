// `home-ctl agent connect`: plan the assistant's config change, ask the owner,
// and only then create the assistant (or, with --client, rotate an existing one)
// and write its config. A "no" leaves nothing behind. Ids that are taken, or that
// belong to a removed assistant, are never reused silently: the next free id is
// chosen and the owner is told which one it is.
import {
  type AgentKind,
  type ConfigChange,
  PLANNING_TOKEN,
} from "../broker/onboard";
import { HomectlError } from "../types";

export interface ConnectDeps {
  list(): Promise<{ id: string }[]>;
  create(input: {
    id: string;
    name: string;
    hosts: string[];
  }): Promise<{ token: string }>;
  rotate(id: string): Promise<{ token: string }>;
  plan(kind: AgentKind, token: string): Promise<ConfigChange[]>;
  apply(change: ConfigChange, token: string): Promise<void>;
  storeToken(token: string): Promise<void>;
  // Returns the id the broker sees for this token.
  whoami(token: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  note(line: string): void;
  setupPrompt(kind: AgentKind): string;
  hostName: string;
}

export interface ConnectOptions {
  kind: AgentKind;
  hosts: string[];
  name?: string;
  // Reconnect this existing assistant: rotate its key and write its config.
  client?: string;
}

export type ConnectResult =
  | {
      id: string;
      applied: true;
      rotated: boolean;
      paths: string[];
      idNote?: string;
    }
  | {
      id: string;
      applied: false;
      rotated: boolean;
      manual: string[];
      prompt: string;
      idNote?: string;
    };

// The re-plan made after create or rotate must match the preview the owner
// approved: the same files, the same contents before the change, the same masked
// diff, and the real token (not the placeholder) in every config it writes.
export function assertSamePlan(
  previewed: ConfigChange[],
  final: ConfigChange[],
  token: string,
): void {
  const same =
    previewed.length === final.length &&
    previewed.every((change, i) => {
      const next = final[i];
      if (next === undefined) return false;
      const sameShape =
        next.path === change.path &&
        next.supported === change.supported &&
        next.before === change.before &&
        next.diff.join("\n") === change.diff.join("\n");
      if (!sameShape) return false;
      if (next.after === undefined) return change.after === undefined;
      if (next.after.includes(PLANNING_TOKEN)) return false;
      const previewHadToken = change.after?.includes(PLANNING_TOKEN) ?? false;
      return !previewHadToken || next.after.includes(token);
    });
  if (!same)
    throw new HomectlError(
      3,
      "The config changed since the preview, so nothing was written. Run agent connect again.",
    );
}

// Lowercase letters, digits and hyphens, starting with a letter, at most 63.
export function normalizeClientId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 63);
}

// The base id if it is free, otherwise the base with the first free suffix:
// claude, claude-2, claude-3. Taken includes removed assistants.
export function freeClientId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 63 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function connectAgent(
  deps: ConnectDeps,
  options: ConnectOptions,
): Promise<ConnectResult> {
  const { kind, hosts } = options;
  const taken = new Set((await deps.list()).map((client) => client.id));
  const rotated = options.client !== undefined;
  let id: string;
  let idNote: string | undefined;
  if (options.client !== undefined) {
    id = options.client.trim().toLowerCase();
    if (!taken.has(id))
      throw new HomectlError(
        2,
        `No assistant named "${id}". List them with home-ctl agent list, or connect a new one without --client.`,
      );
  } else if (options.name !== undefined) {
    id = normalizeClientId(options.name);
    if (taken.has(id))
      throw new HomectlError(
        2,
        `An assistant named "${id}" already exists or was removed. Pick another --name, for example --name ${freeClientId(id, taken)}.`,
      );
  } else {
    const base = normalizeClientId(`${kind}-${deps.hostName}`);
    id = freeClientId(base, taken);
    if (id !== base)
      idNote = `"${base}" is already used by another assistant (or a removed one), so this one is "${id}".`;
  }
  const name = `${kind} on ${deps.hostName}`;

  // Plan first. Nothing is created or rotated before the owner has seen the change.
  // The preview holds a placeholder token; the masked diff is the same either way.
  const changes = await deps.plan(kind, PLANNING_TOKEN);
  const blocked = changes.filter((change) => !change.supported);
  if (blocked.length) {
    // homectl cannot write this agent's config here, so the owner gets the steps.
    // The key is still issued and stored, so those steps can use it.
    const { token } = rotated
      ? await deps.rotate(id)
      : await deps.create({ id, name, hosts });
    await deps.storeToken(token);
    return {
      id,
      applied: false,
      rotated,
      manual: blocked.flatMap((change) => change.manual ?? []),
      prompt: deps.setupPrompt(kind),
      ...(idNote ? { idNote } : {}),
    };
  }
  for (const change of changes) {
    deps.note(`Planned change to ${change.path}:`);
    for (const line of change.diff) deps.note(line);
  }
  const paths = changes.map((change) => change.path);
  deps.note(
    `This puts the assistant's key in ${paths.join(", ")}. Only your user account can read it.`,
  );
  if (!(await deps.confirm("Apply these changes? [y/N] ")))
    throw new HomectlError(3, "Cancelled. Nothing was created or changed.");

  const { token } = rotated
    ? await deps.rotate(id)
    : await deps.create({ id, name, hosts });
  try {
    // Re-plan with the real token and apply that plan, never the preview.
    const final = await deps.plan(kind, token);
    assertSamePlan(changes, final, token);
    for (const change of final) await deps.apply(change, token);
  } catch (error) {
    throw new HomectlError(
      3,
      `The assistant "${id}" was ${rotated ? "given a new key" : "created"}, but its config could not be written: ${(error as Error).message}. Revoke it with home-ctl agent revoke ${id}, or run agent connect again.`,
    );
  }
  await deps.storeToken(token);
  const verified = await deps.whoami(token);
  return {
    id: verified,
    applied: true,
    rotated,
    paths,
    ...(idNote ? { idNote } : {}),
  };
}

// The words the owner reads after `agent connect`.
export function describeConnect(
  result: ConnectResult,
  kind: AgentKind,
): string {
  const lines: string[] = [];
  if (result.idNote) lines.push(result.idNote);
  if (!result.applied) {
    lines.push(
      ...result.manual,
      "",
      "Setup prompt for the agent:",
      result.prompt,
    );
    return lines.join("\n");
  }
  const action = result.rotated
    ? `Connected ${kind} as ${result.id} with a new key. The old key no longer works.`
    : `Connected ${kind} as ${result.id}.`;
  lines.push(
    action,
    "Restart the agent so it picks up the change. The MCP server runs `home-ctl mcp`, so home-ctl must be on the agent's PATH.",
  );
  return lines.join("\n");
}
