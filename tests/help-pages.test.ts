import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanEnv } from "../src/credentials";
import { helpTopics, renderHelp } from "../src/cli/help";

const cli = join(import.meta.dir, "../src/cli/main.ts");

// The action words each parser accepts (src/cli/broker-commands.ts,
// src/cli/workspace-commands.ts, src/broker/host-permissions.ts ownerHostCommand).
const WORKSPACE_ACTIONS = [
  "invite",
  "join",
  "status",
  "clients",
  "pending",
  "decide",
  "remove",
  "leave",
  "sync-now",
  "backup-now",
  "retired",
  "request-backup",
  "restore-preview",
  "restore",
];
const OWNER_ACTIONS = [
  "init",
  "auto-mode",
  "scan-host-keys",
  "pin-host-key",
  "inspect-host",
  "preview-host-grant",
  "apply-host-grant",
  "revoke-host-grant",
  "repair-host-grant",
];
const BROKER_TOPICS = [
  "daemon",
  "owner",
  "workspace",
  "migrate",
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
];

async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    code: await child.exited,
  };
}

describe("help pages for 0.3 commands", () => {
  test("each broker command has its own topic", () => {
    for (const topic of BROKER_TOPICS) expect(helpTopics).toContain(topic);
  });

  test("the workspace page names every workspace action", () => {
    const text = renderHelp("workspace", { width: 100 });
    for (const action of WORKSPACE_ACTIONS) expect(text).toContain(action);
  });

  test("the owner page names every owner action and the host commands", () => {
    const text = renderHelp("owner", { width: 100 });
    for (const action of OWNER_ACTIONS) expect(text).toContain(action);
    expect(text).toContain("SHA256:");
    expect(text).toContain("64 hex characters");
  });

  test("the daemon page documents workspace listen, panel origin and panel port", () => {
    const text = renderHelp("daemon", { width: 100 });
    expect(text).toContain("HOMECTL_WORKSPACE_LISTEN=HOST:PORT");
    expect(text).toContain("HOMECTL_PANEL_ORIGIN");
    expect(text).toContain("HOMECTL_OWNER_PANEL_PORT");
    expect(text).toContain("7451");
  });

  // Whitespace collapsed: the renderer wraps long rows, so phrases can break across lines.
  const flat = (topic: string) =>
    renderHelp(topic, { width: 100 }).replace(/\s+/g, " ");

  test("the daemon page documents the workspace quota and the reviewer key (env only)", () => {
    const text = flat("daemon");
    expect(text).toContain("HOMECTL_WORKSPACE_QUOTA_MB=MIB");
    expect(text).toContain("default 1024");
    expect(text).toContain("HOMECTL_REVIEWER_API_KEY=KEY");
    expect(text).toContain("homectl never writes it");
  });

  test("the workspace page says restore and preview need the owner password and a reason", () => {
    const text = flat("workspace");
    expect(text).toContain("restore <client> <seq> --reason <text>");
    expect(text).toContain("restore-preview <client> [seq] --reason <text>");
    expect(text).toContain("Only inventory.yaml, known_hosts and policy.json");
    expect(text).toContain("prints a code for a fresh device");
    expect(text).not.toContain("PLACEHOLDER");
  });

  test("the agent page documents the owner auto-mode set options and the password check", () => {
    const text = flat("agent");
    expect(text).toContain("Reviewer and Auto Mode");
    expect(text).toContain("owner auto-mode set");
    expect(text).toContain("--authority recommend|routine|delegated");
    expect(text).toContain("--endpoint <url>|none");
    expect(text).toContain("checks the password again");
  });

  test("the owner page documents repair-host-grant: preview, reviewed apply, and what it never touches", () => {
    const text = flat("owner");
    expect(text).toContain("repair-host-grant <host> [fingerprint]");
    expect(text).toContain("Without a fingerprint it previews the diff");
    expect(text).toContain("visudo checks the new file");
    expect(text).toContain("the old content returns if a check fails");
    expect(text).toContain("never creates a missing drop-in");
    expect(text).toContain("never touches a file without homectl's header");
  });

  test("the verify page says the agent's report never changes the state or exit status", () => {
    const text = flat("verify");
    expect(text).toContain(
      "home-ctl verify <operation> passed|failed|inconclusive --summary TEXT",
    );
    expect(text).toContain(
      "never changes the operation's state or its exit status",
    );
    expect(text).toContain("homectl never sets it");
    expect(text).toContain("only by the client that ran the operation");
    expect(text).toContain("only after the run");
    expect(text).toContain("A zero exit status is not proof of health");
  });

  test("the owner page says init asks for the reviewer authority", () => {
    const text = flat("owner");
    expect(text).toContain("then asks for the reviewer authority");
    expect(text).toContain("recommend (default");
  });

  test("the migrate page says the broker migrates on start and --dry-run changes nothing", () => {
    const text = renderHelp("migrate", { width: 100 });
    expect(text).toContain("--dry-run");
    expect(text).toContain("when it starts");
    expect(text).toContain("backup");
  });

  test("unknown topics fall back to the root page", () => {
    const text = renderHelp("no-such-topic", { width: 100 });
    expect(text).toContain("Get started");
    expect(text).toContain("Broker and workspace");
  });
});

describe("help routing", () => {
  test("broker commands answer --help without running the broker", async () => {
    for (const topic of ["workspace", "owner", "daemon", "approve"]) {
      const result = await invoke([topic, "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage");
      expect(result.stderr).not.toContain("Unknown option");
    }
  });

  test("help topics are reachable through help <topic>", async () => {
    const result = await invoke(["help", "owner"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("scan-host-keys");
  });

  test("migrate --help is a known command", async () => {
    const result = await invoke(["migrate", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("Unknown command");
  });
});
