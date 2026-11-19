import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalCommandHistory } from "../src/command-history";
import { cleanEnv } from "../src/credentials";
import { saveInventory } from "../src/inventory";
import { planExecution } from "../src/policies";
import type { Machine } from "../src/types";

const cli = join(import.meta.dir, "../src/cli/main.ts");
const machine: Machine = {
  description: "Test local host",
  transport: "local",
  access: "full",
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-cli-"));
  const path = join(dir, "inventory.yaml");
  await saveInventory(path, { version: 1, machines: { example: machine } });
  return path;
}
async function invoke(args: string[], env = cleanEnv()) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env,
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
test("help works without inventory or credentials", async () => {
  const r = await invoke(["help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("home-ctl");
});
test("known commands without dedicated help pages fall back to global help", async () => {
  for (const command of [
    "setup",
    "update",
    "hosts",
    "inspect",
    "doctor",
    "sudoers",
  ]) {
    const result = await invoke([command, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("home-ctl <command>");
    expect(result.stderr).not.toContain("Unknown command");
  }
});
test("manual pairing join enters the guided flow without requiring serve", async () => {
  const r = await invoke([
    "pair",
    "join",
    "--address",
    "http://192.0.2.10:7448",
    "--inventory",
    await fixture(),
  ]);
  expect(r.code).toBe(5);
  expect(r.stderr).toContain("private interactive terminal");
  expect(r.stderr).not.toContain("Start home-ctl serve");
});
test("missing inventory exits 2", async () => {
  const r = await invoke(["hosts", "--inventory", "/nonexistent-homectl-test"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Cannot read inventory");
});
test("JSON inventory inspection", async () => {
  const r = await invoke([
    "inspect",
    "example",
    "--json",
    "--inventory",
    await fixture(),
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).access).toBe("full");
});
test("unknown host exits 2", async () =>
  expect(
    (await invoke(["inspect", "missing", "--inventory", await fixture()])).code,
  ).toBe(2));
test("missing key inspection names the key and creation command", async () => {
  const result = await invoke([
    "key",
    "inspect",
    "missing-key",
    "--inventory",
    await fixture(),
  ]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(
    "No key named missing-key; create it with `home-ctl key create missing-key`",
  );
});
test("missing command file names the unreadable path", async () => {
  const missing = join(tmpdir(), `homectl-missing-${randomUUID()}.json`);
  const result = await invoke([
    "commands",
    "save",
    "--file",
    missing,
    "--inventory",
    await fixture(),
  ]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(`Cannot read file ${missing}`);
});
test("observe mutation exits 3", async () => {
  const path = await fixture();
  await saveInventory(path, {
    version: 1,
    machines: { example: { ...machine, access: "observe" } },
  });
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    path,
    "--",
    "rm",
    "fixture",
  ]);
  expect(r.code).toBe(3);
});
test("destruction exits 4 before any process executes", async () => {
  const path = await fixture();
  const configPath = `${path}.ssh_config`;
  await writeFile(configPath, "preserve this file");
  const r = await invoke([
    "exec",
    "example",
    "--json",
    "--inventory",
    path,
    "--",
    "rm",
    "/nonexistent-homectl-target",
  ]);
  expect(r.code).toBe(4);
  expect(JSON.parse(r.stderr).details.argv).toEqual([
    "rm",
    "/nonexistent-homectl-target",
  ]);
  expect(await readFile(configPath, "utf8")).toBe("preserve this file");
});
test("dry-run returns concrete effects and digest without files", async () => {
  const path = await fixture();
  const r = await invoke([
    "exec",
    "example",
    "--json",
    "--inventory",
    path,
    "--dry-run",
    "--impact",
    "Remove only fixture",
    "--",
    "rm",
    "fixture",
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).plan.approval).toHaveLength(64);
  expect(await Bun.file(`${path}.ssh_config`).exists()).toBe(false);
});
test("safe command emits result and exit 0", async () => {
  const r = await invoke([
    "exec",
    "example",
    "--json",
    "--inventory",
    await fixture(),
    "--",
    "whoami",
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).result.stdout.trim().length).toBeGreaterThan(0);
});
test("commands CLI saves, lists and refuses a mutating run without approval", async () => {
  const path = await fixture();
  const templatePath = join(tmpdir(), `saved-${randomUUID()}.json`);
  try {
    await writeFile(
      templatePath,
      JSON.stringify({
        name: "Restart nginx",
        hosts: ["example"],
        argv: ["systemctl", "restart", "nginx"],
      }),
    );
    const saved = await invoke([
      "commands",
      "save",
      "--file",
      templatePath,
      "--inventory",
      path,
      "--json",
    ]);
    expect(saved.code).toBe(0);
    const id = (JSON.parse(saved.stdout) as { command: { id: string } }).command
      .id;
    const listed = await invoke([
      "commands",
      "list",
      "--inventory",
      path,
      "--json",
    ]);
    expect((JSON.parse(listed.stdout) as { id: string }[])[0]?.id).toBe(id);

    const preview = await invoke([
      "commands",
      "run",
      id,
      "--target",
      "example",
      "--inventory",
      path,
      "--dry-run",
      "--json",
    ]);
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout).plan.needsApproval).toBe(true);
    const refused = await invoke([
      "commands",
      "run",
      id,
      "--target",
      "example",
      "--inventory",
      path,
      "--json",
    ]);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain("owner's approval");
    expect(refused.stderr).toContain("homectl broker");
    const journal = await readFile(
      join(path, "..", "control-plane", "audit.jsonl"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(journal).not.toContain("command.");
    const history = await readLocalCommandHistory(path);
    if (process.getuid?.() === 0) {
      expect(history).toEqual([]);
    } else {
      expect(history.map((entry) => entry.status)).toContain(
        "approval-required",
      );
    }
  } finally {
    await rm(templatePath, { force: true });
  }
});
test("--approval is rejected with a pointer to the broker", async () => {
  const path = await fixture();
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    path,
    "--approval",
    "deadbeef",
    "--",
    "hostname",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--approval was removed in homectl 0.3.0");
});
// The approved execution path below is what the broker daemon drives after the
// owner signs a grant; it is no longer reachable from the agent's CLI.
async function approvedRun(path: string, argv: string[]) {
  const { loadInventory } = await import("../src/inventory");
  const { hostCommand } = await import("../src/cli/host-commands");
  const emitted: unknown[] = [];
  const code = await hostCommand("exec", "example", {
    inventory: await loadInventory(path),
    inventoryPath: path,
    configPath: join(path, "..", "ssh_config"),
    commandArgs: argv,
    dryRun: false,
    approval: planExecution("example", machine, argv).approval,
    emit: (value) => emitted.push(value),
  });
  return { code, emitted };
}
test("remote failure exits 6 and preserves actual exit status", async () => {
  const path = await fixture();
  const r = await approvedRun(path, [
    process.execPath,
    "-e",
    "process.exit(7)",
  ]);
  expect(r.code).toBe(6);
  expect(
    (r.emitted[0] as { result: { exitCode: number } }).result.exitCode,
  ).toBe(7);
});
test("spawn failure exits 5 without environment dumping", async () => {
  const path = await fixture();
  const failure = (await approvedRun(path, [
    "nonexistent-homectl-executable",
  ]).catch((error: unknown) => error)) as { code: number; message: string };
  expect(failure.code).toBe(5);
  expect(failure.message).toContain("details suppressed");
});
test("all SSH addresses regenerate from current inventory before diagnostics", async () => {
  const path = await fixture();
  const toolsDir = `${path}.tools`;
  await mkdir(toolsDir);
  for (const name of ["ssh", "bun", "ssh-agent", "ssh-add", "keepassxc-cli"])
    await writeFile(join(toolsDir, name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  await saveInventory(path, {
    version: 1,
    session: { ttl: "24h", database: "/tmp/homectl-test/homelab.kdbx" },
    machines: {
      example: {
        description: "Example",
        transport: "ssh",
        ssh_alias: "example",
        address: "127.0.0.1",
        port: 1,
        user: "operator",
        access: "user",
        auth: {
          type: "keepassxc",
          socket: "/tmp/homectl-test/inventory.yaml.session/agent.sock",
          entry: "homectl-example",
          public_key: "/tmp/homectl-test/example.pub",
        },
      },
    },
  });
  const env = cleanEnv();
  await invoke(["doctor", "--inventory", path, "--json"], {
    ...env,
    PATH: `${toolsDir}:${env.PATH ?? ""}`,
  });
  const generated = await readFile(`${path}.ssh_config`, "utf8");
  expect(generated).toContain("127.0.0.1");
  expect(generated).toContain("Port 1");
});
test("unknown flags cannot silently change CLI behavior", async () => {
  const r = await invoke(["hosts", "--yes", "--inventory", await fixture()]);
  expect(r.code).toBe(2);
});
test("sync apply requires an explicit reviewed choices file", async () => {
  const result = await invoke([
    "sync",
    "apply",
    "synthetic-preview",
    "--inventory",
    await fixture(),
    "--json",
  ]);
  expect(result.code).toBe(4);
  expect(result.stderr).toContain(
    "Review the preview, then provide explicit choices with --file PATH",
  );
});

test("parameterized command previews and JSON errors expose redacted expanded argv", async () => {
  const path = await fixture();
  const templatePath = join(tmpdir(), `saved-param-${randomUUID()}.json`);
  const secretValue = "private-value-that-must-not-be-echoed";
  const template = {
    name: "Remove named target",
    hosts: ["example"],
    argv: ["rm", "{{target}}"],
    parameters: [{ name: "target", secret: true }],
    description: "Remove {{target}}",
  };
  try {
    await writeFile(templatePath, JSON.stringify(template));
    const saved = await invoke([
      "commands",
      "save",
      "--file",
      templatePath,
      "--inventory",
      path,
      "--json",
    ]);
    expect(saved.code).toBe(0);
    const id = JSON.parse(saved.stdout).command.id as string;
    const runArgs = [
      "commands",
      "run",
      id,
      "--target",
      "example",
      "--inventory",
      path,
      "--json",
      "--",
      `target=${secretValue}`,
    ];
    const preview = await invoke([
      ...runArgs.slice(0, -2),
      "--dry-run",
      ...runArgs.slice(-2),
    ]);
    expect(preview.code).toBe(0);
    const previewPlan = JSON.parse(preview.stdout).plan;
    expect(previewPlan.argv).toEqual(["rm", "[REDACTED]"]);
    expect(preview.stdout).not.toContain(secretValue);

    const refused = await invoke(runArgs);
    expect(refused.code).toBe(4);
    const error = JSON.parse(refused.stderr);
    expect(error.details.argv).toEqual(["rm", "[REDACTED]"]);
    expect(refused.stderr).not.toContain(secretValue);
  } finally {
    await rm(templatePath, { force: true });
  }
});

test("peer and pairing dry runs never contact serve or read launch tokens", async () => {
  for (const args of [
    ["pair", "open"],
    ["sync", "apply", "synthetic-preview", "--file", "/does-not-exist"],
    ["peer", "synthetic-peer", "--target", "nas", "--", "uname", "-s"],
    ["panel"],
  ]) {
    const split = args.indexOf("--");
    const cliArgs =
      split < 0
        ? [...args, "--dry-run", "--json"]
        : [
            ...args.slice(0, split),
            "--dry-run",
            "--json",
            ...args.slice(split),
          ];
    const result = await invoke(cliArgs);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).credentialAccess).toBe(false);
  }
});

test("default hosts output is human readable while JSON stays structured", async () => {
  const path = await fixture();
  const human = await invoke(["hosts", "--inventory", path]);
  expect(human.stdout).toContain("Machine");
  expect(human.stdout).toContain("example");
  expect(human.stdout).not.toContain('"transport"');
  const json = await invoke(["hosts", "--inventory", path, "--json"]);
  expect(JSON.parse(json.stdout).example.transport).toBe("local");
});
test("argument errors honor JSON even if argument parsing fails", async () => {
  const result = await invoke(["hosts", "--invalid-option", "--json"]);
  expect(JSON.parse(result.stderr).code).toBe(2);
  const human = await invoke(["hosts", "--invalid-option"]);
  expect(human.stderr).toStartWith("Error:");
  expect(human.stderr).toContain("Unknown option");
});
