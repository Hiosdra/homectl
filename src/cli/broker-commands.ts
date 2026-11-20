// 0.3.0 CLI surface for the broker. Agent commands (exec, wait, op, cancel,
// verify, task) talk to the daemon with the agent's client token. Owner commands
// (approvals, approve, deny, agent, owner) ask for the owner password in a
// private terminal every time; nothing the agent can read grants approval.
import { hostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { callBroker, clientToken, findEndpoint } from "../broker/client";
import type { Endpoint } from "../broker/paths";
import { readPassword } from "../session";
import { checkLocalExecOptions } from "./exec-local-options";
import { paths } from "../setup";
import { HomectlError } from "../types";
import { ownerCommand } from "./owner-commands";
import { workspaceCommand } from "./workspace-commands";
import { verificationNote, verifyCommand } from "./verify-command";

export const BROKER_COMMANDS = new Set([
  "daemon",
  "owner",
  "approvals",
  "approve",
  "deny",
  "wait",
  "op",
  "cancel",
  "verify",
  "task",
  "agent",
  "mcp",
  "workspace",
]);

export const APPROVAL_REMOVED =
  "--approval was removed in homectl 0.3.0. Changes are approved by the owner in the panel or with `home-ctl approve <operation>`; the agent waits with `home-ctl wait <operation>`.";

type Emit = (value: unknown, human?: string) => void;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function requireEndpoint(inventoryPath: string): Promise<Endpoint> {
  const endpoint = await findEndpoint(inventoryPath);
  if (!endpoint)
    throw new HomectlError(
      5,
      "The homectl broker is not running. Start it with `home-ctl daemon run` (or install the service with `home-ctl daemon install`).",
    );
  return endpoint;
}

async function agentAuth(inventoryPath: string) {
  const endpoint = await requireEndpoint(inventoryPath);
  const token = await clientToken();
  if (!token)
    throw new HomectlError(
      3,
      "This agent has no homectl client token. The owner connects it with `home-ctl agent connect`.",
    );
  return { endpoint, authorization: `Bearer ${token}` };
}

async function ownerAuth(inventoryPath: string) {
  const endpoint = await requireEndpoint(inventoryPath);
  const password = await readPassword("homectl owner password: ");
  const { token } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password },
    { endpoint },
  );
  return { endpoint, authorization: `Owner ${token}`, password };
}

function exitFor(view: { state: string; result?: { exitCode: number } }) {
  switch (view.state) {
    case "succeeded":
      return 0;
    case "failed":
      return view.result ? 6 : 5;
    case "awaiting-approval":
      return 4;
    case "denied":
    case "cancelled":
    case "expired":
      return 3;
    default:
      return 5;
  }
}

function describe(view: {
  id: string;
  state: string;
  approvalSurface?: string;
  result?: { stdout: string; stderr: string };
  reason?: string;
  decision?: { reason: string };
  verification?: { status: string; summary: string };
}) {
  const text = outcome(view);
  const note = verificationNote(view);
  return note ? `${text}\n${note}` : text;
}

function outcome(view: {
  id: string;
  state: string;
  approvalSurface?: string;
  result?: { stdout: string; stderr: string };
  reason?: string;
  decision?: { reason: string };
}) {
  if (view.state === "awaiting-approval")
    return `Waiting for the owner to approve operation ${view.id}${view.approvalSurface ? ` at ${view.approvalSurface}` : ""}. Ask the user to approve it, then run: home-ctl wait ${view.id}`;
  if (view.result)
    return `${view.result.stdout}${view.result.stderr}`.trimEnd();
  return `Operation ${view.id}: ${view.state}${view.reason ? ` (${view.reason})` : ""}${view.decision ? ` - ${view.decision.reason}` : ""}`;
}

// Returns an exit code, or undefined when the broker should not handle it.
export async function brokerCommand(
  raw: string[],
  options: { inventoryPath: string; emit: Emit; json: boolean },
): Promise<number | undefined> {
  const split = raw.indexOf("--");
  const cliArgs = split < 0 ? raw : raw.slice(0, split);
  const argv = split < 0 ? [] : raw.slice(split + 1);
  const [command] = cliArgs;
  if (!command) return undefined;
  if (cliArgs.includes("--approval"))
    throw new HomectlError(2, APPROVAL_REMOVED);
  // exec/ssh go through the broker whenever the agent is connected to one.
  if (command === "exec" || command === "ssh") {
    const endpoint = await findEndpoint(options.inventoryPath);
    if (!endpoint || !(await clientToken())) {
      checkLocalExecOptions(cliArgs);
      return undefined;
    }
  } else if (!BROKER_COMMANDS.has(command)) return undefined;
  const { values: v, positionals } = parseArgs({
    args: cliArgs.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      inventory: { type: "string" },
      impact: { type: "string" },
      wait: { type: "string" },
      task: { type: "string" },
      remember: { type: "boolean" },
      summary: { type: "string" },
      hosts: { type: "string" },
      name: { type: "string" },
      mode: { type: "string" },
      authority: { type: "string" },
      endpoint: { type: "string" },
      model: { type: "string" },
      ttl: { type: "string" },
      "dry-run": { type: "boolean" },
      "remote-approval": { type: "boolean" },
      reason: { type: "string" },
    },
  });
  const { inventoryPath, emit } = options;
  const waitMs = v.wait === undefined ? 120_000 : Number(v.wait) * 1000;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 600_000)
    throw new HomectlError(2, "--wait takes 0 to 600 seconds");

  switch (command) {
    case "exec":
    case "ssh": {
      const [host] = positionals;
      if (!host || !argv.length)
        throw new HomectlError(2, "Usage: home-ctl exec <host> -- <argv...>");
      const view = await callBroker<
        Parameters<typeof describe>[0] & { result?: { exitCode: number } }
      >(
        "/v1/exec",
        {
          host,
          argv,
          ...(v.impact ? { impact: v.impact } : {}),
          ...(v.task ? { task: v.task } : {}),
          waitMs,
        },
        await agentAuth(inventoryPath),
      );
      emit(view, describe(view));
      return exitFor(view);
    }
    case "wait":
    case "op": {
      const [id] = positionals;
      if (!id)
        throw new HomectlError(2, `Usage: home-ctl ${command} <operation>`);
      const view = await callBroker<
        Parameters<typeof describe>[0] & { result?: { exitCode: number } }
      >(
        command === "wait" ? "/v1/wait" : "/v1/status",
        command === "wait" ? { id, timeoutMs: waitMs } : { id },
        await agentAuth(inventoryPath),
      );
      emit(view, describe(view));
      return exitFor(view);
    }
    case "cancel": {
      const [id] = positionals;
      if (!id) throw new HomectlError(2, "Usage: home-ctl cancel <operation>");
      const view = await callBroker<Parameters<typeof describe>[0]>(
        "/v1/cancel",
        { id },
        await agentAuth(inventoryPath),
      );
      emit(view, describe(view));
      return 0;
    }
    case "verify":
      return verifyCommand(positionals, {
        summary: v.summary,
        auth: () => agentAuth(inventoryPath),
        emit,
      });
    case "task": {
      const [action, ...rest] = positionals;
      const auth = await agentAuth(inventoryPath);
      if (action === "open") {
        const task = await callBroker<{ id: string; expiresAt: number }>(
          "/v1/task/open",
          {
            title: rest.join(" "),
            ...(v.ttl ? { ttlMs: Number(v.ttl) * 60_000 } : {}),
          },
          auth,
        );
        emit(task, `Task ${task.id} is open. Pass --task ${task.id} to exec.`);
        return 0;
      }
      if (action === "close" && rest[0]) {
        emit(
          await callBroker("/v1/task/close", { id: rest[0] }, auth),
          "Task closed.",
        );
        return 0;
      }
      throw new HomectlError(
        2,
        'Usage: home-ctl task open "<title>" | task close <id>',
      );
    }
    case "approvals": {
      const auth = await ownerAuth(inventoryPath);
      const pending = await callBroker<
        {
          id: string;
          client: string;
          host: string;
          argv: string[];
          risk: string;
          impact: string;
          fingerprint: string;
        }[]
      >("/v1/owner/pending", {}, auth);
      emit(
        pending,
        pending.length
          ? pending
              .map(
                (p) =>
                  `${p.id}  ${p.client} -> ${p.host}  [${p.risk}]\n    ${JSON.stringify(p.argv)}\n    ${p.impact}`,
              )
              .join("\n")
          : "Nothing is waiting for approval.",
      );
      return 0;
    }
    case "approve":
    case "deny": {
      const [id] = positionals;
      if (!id)
        throw new HomectlError(
          2,
          `Usage: home-ctl ${command} <operation> [--remember]`,
        );
      const auth = await ownerAuth(inventoryPath);
      const pending = await callBroker<{ id: string; fingerprint: string }[]>(
        "/v1/owner/pending",
        {},
        auth,
      );
      const op = pending.find((p) => p.id === id);
      if (!op)
        throw new HomectlError(3, "That operation is not waiting for approval");
      const decision =
        command === "approve"
          ? v.remember
            ? "approve-remember"
            : "approve-once"
          : v.remember
            ? "deny-remember"
            : "deny-once";
      const result = await callBroker<{ operation: { state: string } }>(
        "/v1/owner/decide",
        {
          operationId: id,
          fingerprint: op.fingerprint,
          decision,
          password: auth.password,
        },
        auth,
      );
      emit(
        result,
        `${command === "approve" ? "Approved" : "Denied"}: ${id} (${result.operation.state})`,
      );
      return 0;
    }
    case "agent": {
      const [action, id] = positionals;
      const auth = await ownerAuth(inventoryPath);
      if (action === "list") {
        emit(await callBroker("/v1/owner/clients/list", {}, auth));
        return 0;
      }
      if (!id)
        throw new HomectlError(
          2,
          "Usage: home-ctl agent connect|rotate|revoke <id>",
        );
      if (action === "connect") {
        const kind = id as "codex" | "claude" | "other";
        if (!["codex", "claude", "other"].includes(kind))
          throw new HomectlError(
            2,
            "Usage: home-ctl agent connect codex|claude|other --hosts a,b",
          );
        const onboard = await import("../broker/onboard");
        const hosts = (v.hosts ?? "")
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean);
        const clientId = (v.name ?? `${kind}-${hostname()}`)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/^[^a-z]+/, "")
          .slice(0, 63);
        const created = await callBroker<{ token: string }>(
          "/v1/owner/clients/create",
          {
            id: clientId,
            name: `${kind} on ${hostname()}`,
            hosts,
            password: auth.password,
          },
          auth,
        );
        // All reviewed changes apply together, or none does.
        const changes = await onboard.planAgentConfig(kind, created.token);
        const blocked = changes.filter((change) => !change.supported);
        if (blocked.length) {
          await onboard.storeClientToken(created.token);
          const manual = blocked.flatMap((change) => change.manual ?? []);
          emit(
            {
              id: clientId,
              applied: false,
              manual,
              prompt: onboard.setupPrompt(kind),
            },
            [
              ...manual,
              "",
              "Setup prompt for the agent:",
              onboard.setupPrompt(kind),
            ].join("\n"),
          );
          return 0;
        }
        console.error(
          changes
            .map(
              (change) =>
                `Planned change to ${change.path}:\n${change.diff.join("\n")}`,
            )
            .join("\n\n"),
        );
        if (!(await confirm("Apply these changes? [y/N] ")))
          throw new HomectlError(
            3,
            "Cancelled; the client was created but not configured. Revoke it with `home-ctl agent revoke`.",
          );
        for (const change of changes)
          await onboard.applyAgentConfig(change, created.token);
        // The MCP server reads this file; the agent config holds the same token.
        await onboard.storeClientToken(created.token);
        const who = await callBroker<{ id: string }>(
          "/v1/whoami",
          {},
          { endpoint: auth.endpoint, authorization: `Bearer ${created.token}` },
        );
        emit(
          {
            id: who.id,
            applied: true,
            paths: changes.map((change) => change.path),
            verified: true,
          },
          `Connected ${kind} as ${who.id}. Restart the agent so it picks up the change. The MCP server runs \`home-ctl mcp\`, so home-ctl must be on the agent's PATH.`,
        );
        return 0;
      }
      if (action === "rotate") {
        const rotated = await callBroker<{ token: string }>(
          "/v1/owner/clients/rotate",
          { id, password: auth.password },
          auth,
        );
        await (
          await import("../broker/onboard")
        ).storeClientToken(rotated.token);
        emit({ id, rotated: true }, `Token for ${id} rotated.`);
        return 0;
      }
      if (action === "revoke") {
        emit(
          await callBroker("/v1/owner/clients/revoke", { id }, auth),
          `Agent client ${id} revoked.`,
        );
        return 0;
      }
      throw new HomectlError(
        2,
        "Usage: home-ctl agent connect|list|rotate|revoke",
      );
    }
    case "owner":
      return ownerCommand(positionals, {
        inventoryPath,
        flags: v,
        argv,
        emit,
        auth: () => ownerAuth(inventoryPath),
      });
    case "workspace":
      return workspaceCommand(positionals, {
        auth: () => ownerAuth(inventoryPath),
        emit,
        remoteApproval: v["remote-approval"] ?? false,
        reason: v.reason,
      });
    case "mcp":
      // stdio MCP server: stdout carries protocol messages only.
      await (await import("../mcp/stdio")).runMcpStdio({ inventoryPath });
      return 0;
    case "daemon":
      return (await import("./daemon-command")).daemonCommand(positionals, {
        inventoryPath,
        sshConfigPath: v.inventory
          ? `${inventoryPath}.ssh_config`
          : paths().ssh,
        mode: v.mode,
        dryRun: v["dry-run"] ?? false,
        emit,
      });
  }
  return undefined;
}

// Entry from main(): resolves --inventory and the output style, then hands over.
export function brokerCli(raw: string[], json: boolean) {
  const split = raw.indexOf("--");
  const cliArgs = split < 0 ? raw : raw.slice(0, split);
  const flag = cliArgs.indexOf("--inventory");
  const explicit = flag >= 0 ? cliArgs[flag + 1] : undefined;
  return brokerCommand(raw, {
    inventoryPath: explicit ? resolve(explicit) : paths().inventory,
    json,
    emit: (value, human) =>
      console.log(
        json || human === undefined
          ? JSON.stringify(value, null, json ? 0 : 2)
          : human,
      ),
  });
}
