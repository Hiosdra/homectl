import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditJournal } from "../src/control/journal";
import { execute } from "../src/operations";
import { checkApproval, planExecution } from "../src/policies";
import {
  expandSavedCommand,
  redactSavedCommandArgv,
  SavedCommandStore,
} from "../src/saved-commands";
import type { Machine } from "../src/types";

const machine: Machine = {
  description: "Synthetic",
  transport: "local",
  access: "full",
};
const template = {
  name: "Restart service",
  hosts: ["example"],
  argv: ["systemctl", "restart", "{{unit}}"],
  parameters: [{ name: "unit", description: "Service unit" }],
  description: "Restart one named service",
};

async function directory() {
  return mkdtemp(join(tmpdir(), "homectl-saved-command-review-"));
}

test("redacted command-start audit permits secret-bearing argv execution", async () => {
  const dir = await directory();
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const argv = ["rm", "--password=hunter2"];
    const preview = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      dryRun: true,
    });
    let runs = 0;
    await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      approval: preview.plan.approval,
      audit: { inventoryPath },
      runner: async () => {
        runs++;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(runs).toBe(1);
    const journal = new AuditJournal(
      join(dir, "control-plane", "audit.jsonl"),
      join(dir, "control-plane", "audit.anchor"),
    );
    const entries = await journal.read();
    expect(
      entries.some((entry) => entry.event.event === "command.started"),
    ).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("hunter2");
    expect(JSON.stringify(entries)).toContain("--password=[REDACTED]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("root-session refusals do not create the user's audit journal", async () => {
  const dir = await directory();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const inventoryPath = join(dir, "inventory.yaml");
  const auditPath = join(dir, "control-plane", "audit.jsonl");
  try {
    await expect(
      execute("example", { ...machine, access: "observe" }, ["rm", "fixture"], {
        configPath: join(dir, "ssh_config"),
        getUid: () => 0,
        audit: { inventoryPath },
        runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toMatchObject({
      code: 3,
      message:
        "Run homectl as a non-root existing user for non-full local tiers",
    });
    expect(await Bun.file(auditPath).exists()).toBe(false);
    expect(
      await Bun.file(join(dir, "control-plane", "audit.anchor")).exists(),
    ).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("was not added to the user's audit journal"),
    );
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit failures do not replace policy or approval refusal errors", async () => {
  const dir = await directory();
  const inventoryPath = join(dir, "inventory.yaml");
  const controlDirectory = join(dir, "control-plane");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(controlDirectory, "audit.jsonl"), "not valid JSON\n");
    const audit = { inventoryPath };
    await expect(
      execute("example", { ...machine, access: "observe" }, ["rm", "fixture"], {
        configPath: join(dir, "ssh_config"),
        getUid: () => 1000,
        audit,
      }),
    ).rejects.toMatchObject({ code: 3 });
    await expect(
      execute("example", machine, ["rm", "fixture"], {
        configPath: join(dir, "ssh_config"),
        requireApproval: true,
        audit,
      }),
    ).rejects.toMatchObject({ code: 4 });
    expect(warning).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved token parameter templates execute while audit stores only redacted argv", async () => {
  const dir = await directory();
  const secretValue = "private-token-parameter";
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const saved = await new SavedCommandStore(
      join(dir, "saved-commands.json"),
    ).save({
      ...template,
      argv: ["rm", "--token={{tok}}"],
      parameters: [{ name: "tok" }],
    });
    const argv = expandSavedCommand(saved, "example", { tok: secretValue });
    const displayArgv = redactSavedCommandArgv(saved, argv, {
      tok: secretValue,
    });
    const preview = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      dryRun: true,
      requireApproval: true,
      displayArgv,
      displayImpact: saved.description,
    });
    let executedArgv: string[] = [];
    await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      approval: preview.plan.approval,
      approvalContext: "cli",
      requireApproval: true,
      displayArgv,
      displayImpact: saved.description,
      audit: { inventoryPath },
      runner: async (spec) => {
        executedArgv = spec.argv;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(executedArgv).toEqual(argv);
    const journal = await readFile(
      join(dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(journal).toContain("--token=[REDACTED]");
    expect(journal).not.toContain(secretValue);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parameterized plans show expanded argv while approval binds its exact form", async () => {
  const dir = await directory();
  const parameterValue = "nginx.service";
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const saved = await new SavedCommandStore(
      join(dir, "saved-commands.json"),
    ).save({
      ...template,
      argv: ["rm", "{{unit}}"],
      parameters: [{ name: "unit" }],
      description: "Remove one service unit",
    });
    const argv = expandSavedCommand(saved, "example", { unit: parameterValue });
    const displayArgv = redactSavedCommandArgv(saved, argv, {
      unit: parameterValue,
    });
    const impact = saved.description ?? "";
    const preview = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      dryRun: true,
      requireApproval: true,
      displayArgv,
      displayImpact: impact,
    });
    expect(preview.plan.argv).toEqual(["rm", parameterValue]);
    expect(preview.plan.argv).not.toEqual(saved.argv);
    expect(preview.plan.impact).toBe(impact);
    expect(preview.plan.approval).toBe(
      planExecution("example", machine, argv).approval,
    );
    expect(preview.plan.approval).not.toBe(
      planExecution("example", machine, saved.argv, impact).approval,
    );
    await expect(
      execute("example", machine, argv, {
        configPath: join(dir, "ssh_config"),
        requireApproval: true,
        displayArgv,
        displayImpact: impact,
      }),
    ).rejects.toMatchObject({
      code: 4,
      details: { argv: displayArgv, impact },
    });

    let executedArgv: string[] = [];
    const result = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      requireApproval: true,
      approval: preview.plan.approval,
      displayArgv,
      displayImpact: impact,
      audit: { inventoryPath },
      runner: async (spec) => {
        executedArgv = spec.argv;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(executedArgv).toEqual(argv);
    expect(result.plan.argv).toEqual(displayArgv);
    const journal = await readFile(
      join(dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(journal).toContain(parameterValue);
    expect(journal).not.toContain("{{unit}}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret-flagged saved parameters stay masked in plans, errors, and audit", async () => {
  const dir = await directory();
  const secretValue = "private-secret-value";
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const saved = await new SavedCommandStore(
      join(dir, "saved-commands.json"),
    ).save({
      ...template,
      argv: ["rm", "{{token}}"],
      parameters: [{ name: "token", secret: true }],
    });
    const values = { token: secretValue };
    const argv = expandSavedCommand(saved, "example", values);
    const displayArgv = redactSavedCommandArgv(saved, argv, values);
    const preview = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      dryRun: true,
      requireApproval: true,
      displayArgv,
    });
    expect(preview.plan.argv).toEqual(["rm", "[REDACTED]"]);
    await expect(
      execute("example", machine, argv, {
        configPath: join(dir, "ssh_config"),
        requireApproval: true,
        displayArgv,
      }),
    ).rejects.toMatchObject({ details: { argv: displayArgv } });
    await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      requireApproval: true,
      approval: preview.plan.approval,
      displayArgv,
      auditArgv: displayArgv,
      audit: { inventoryPath },
      runner: async (spec) => {
        expect(spec.argv).toEqual(argv);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const journal = await readFile(
      join(dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(journal).not.toContain(secretValue);
    expect(journal).toContain("[REDACTED]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval guidance is specific to CLI, panel and peer contexts", () => {
  const plan = planExecution("example", machine, ["rm", "fixture"]);
  for (const [context, message] of [
    ["cli", "--approval <digest>"],
    ["panel", "Request approval and Accept in the panel"],
    ["peer", "Peer approval digest mismatch"],
  ] as const)
    expect(() => checkApproval(plan, undefined, context)).toThrow(message);
});
