import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditJournal } from "../src/control/journal";
import { execute } from "../src/operations";
import { checkApproval, planExecution } from "../src/policies";
import { expandSavedCommand, SavedCommandStore } from "../src/saved-commands";
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
    const preview = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      dryRun: true,
      requireApproval: true,
      displayArgv: saved.argv,
      displayImpact: saved.description,
    });
    let executedArgv: string[] = [];
    await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      approval: preview.plan.approval,
      approvalContext: "cli",
      requireApproval: true,
      displayArgv: saved.argv,
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

test("parameterized plans display templates while approval binds expanded argv", async () => {
  const dir = await directory();
  const secretValue = "private-parameter-value";
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const saved = await new SavedCommandStore(
      join(dir, "saved-commands.json"),
    ).save({
      ...template,
      argv: ["rm", "{{unit}}"],
      parameters: [{ name: "unit" }],
    });
    const argv = expandSavedCommand(saved, "example", { unit: secretValue });
    const impact = "Remove {{unit}}";
    const preview = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      dryRun: true,
      requireApproval: true,
      displayArgv: saved.argv,
      displayImpact: impact,
    });
    expect(preview.plan.argv).toEqual(saved.argv);
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
        displayArgv: saved.argv,
        displayImpact: impact,
      }),
    ).rejects.toMatchObject({
      code: 4,
      details: { argv: saved.argv, impact },
    });

    let executedArgv: string[] = [];
    const result = await execute("example", machine, argv, {
      configPath: join(dir, "ssh_config"),
      requireApproval: true,
      approval: preview.plan.approval,
      displayArgv: saved.argv,
      displayImpact: impact,
      audit: { inventoryPath },
      runner: async (spec) => {
        executedArgv = spec.argv;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(executedArgv).toEqual(argv);
    expect(result.plan.argv).toEqual(saved.argv);
    const journal = await readFile(
      join(dir, "control-plane", "audit.jsonl"),
      "utf8",
    );
    expect(journal).toContain("{{unit}}");
    expect(journal).not.toContain(secretValue);
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
