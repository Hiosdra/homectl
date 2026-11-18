import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalCommandHistory } from "../src/command-history";
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

test("redacted local command history permits secret-bearing argv execution", async () => {
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
    expect(await journal.read()).toEqual([]);
    const entries = await readLocalCommandHistory(inventoryPath);
    if (process.getuid?.() === 0) {
      expect(entries).toEqual([]);
    } else {
      expect(entries.map((entry) => entry.phase)).toEqual([
        "started",
        "outcome",
      ]);
      expect(JSON.stringify(entries)).not.toContain("hunter2");
      expect(JSON.stringify(entries)).toContain("--password=[REDACTED]");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("control-plane journal failures do not replace command refusal errors", async () => {
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
    expect(
      warning.mock.calls.some(([message]) =>
        String(message).includes("audit journal"),
      ),
    ).toBe(false);
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid control-plane journal does not affect ordinary command recording", async () => {
  const dir = await directory();
  const inventoryPath = join(dir, "inventory.yaml");
  let runs = 0;
  try {
    await mkdir(join(dir, "control-plane"), { recursive: true });
    await writeFile(
      join(dir, "control-plane", "audit.jsonl"),
      "not valid JSON\n",
    );
    const result = await execute("example", machine, ["hostname"], {
      configPath: join(dir, "ssh_config"),
      audit: { inventoryPath },
      runner: async () => {
        runs++;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(runs).toBe(1);
    expect(result.result?.exitCode).toBe(0);
    expect(
      await readFile(join(dir, "control-plane", "audit.jsonl"), "utf8"),
    ).toBe("not valid JSON\n");
    const history = await readLocalCommandHistory(inventoryPath);
    if (process.getuid?.() === 0) expect(history).toEqual([]);
    else expect(history.map((entry) => entry.status)).toEqual(["executing", "succeeded"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only successfully approved local-history runs record the approver", async () => {
  const dir = await directory();
  const inventoryPath = join(dir, "inventory.yaml");
  const journal = new AuditJournal(
    join(dir, "control-plane", "audit.jsonl"),
    join(dir, "control-plane", "audit.anchor"),
  );
  const inspectId = "11111111-1111-4111-8111-111111111111";
  const mutationId = "22222222-2222-4222-8222-222222222222";
  try {
    await execute("example", machine, ["hostname"], {
      configPath: join(dir, "ssh_config"),
      approval: "stray-approval",
      audit: {
        inventoryPath,
        approver: "local-operator",
        operationId: inspectId,
      },
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const preview = await execute(
      "example",
      machine,
      ["systemctl", "restart", "nginx"],
      {
        configPath: join(dir, "ssh_config"),
        dryRun: true,
        requireApproval: true,
      },
    );
    await execute("example", machine, ["systemctl", "restart", "nginx"], {
      configPath: join(dir, "ssh_config"),
      requireApproval: true,
      approval: preview.plan.approval,
      approvalContext: "cli",
      audit: {
        inventoryPath,
        approver: "local-operator",
        operationId: mutationId,
      },
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(await journal.read()).toEqual([]);
    const entries = await readLocalCommandHistory(inventoryPath);
    if (process.getuid?.() === 0) {
      expect(entries).toEqual([]);
    } else {
      expect(
        entries.find(
          (entry) => entry.operationId === inspectId && entry.phase === "outcome",
        )?.approver,
      ).toBeUndefined();
      expect(
        entries.find(
          (entry) => entry.operationId === mutationId && entry.phase === "outcome",
        )?.approver,
      ).toBe("local-operator");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a locked KeePassXC session is locally recorded as refused before the runner", async () => {
  const dir = await directory();
  const inventoryPath = join(dir, "inventory.yaml");
  const journal = new AuditJournal(
    join(dir, "control-plane", "audit.jsonl"),
    join(dir, "control-plane", "audit.anchor"),
  );
  let runs = 0;
  const keepassMachine: Machine = {
    description: "Synthetic SSH host",
    transport: "ssh",
    access: "full",
    address: "192.0.2.10",
    user: "operator",
    ssh_alias: "example",
    auth: {
      type: "keepassxc",
      socket: join(dir, "session", "agent.sock"),
      entry: "homectl-example",
      public_key: join(dir, "public-keys", "example.pub"),
    },
  };
  try {
    await expect(
      execute("example", keepassMachine, ["hostname"], {
        configPath: join(dir, "ssh_config"),
        audit: { inventoryPath },
        runner: async () => {
          runs++;
          return { exitCode: 255, stdout: "", stderr: "locked" };
        },
      }),
    ).rejects.toThrow();
    expect(await journal.read()).toEqual([]);
    const entries = await readLocalCommandHistory(inventoryPath);
    expect(runs).toBe(0);
    if (process.getuid?.() === 0) expect(entries).toEqual([]);
    else expect(entries).toMatchObject([
      { phase: "outcome", status: "refused", reason: "SSH session locked" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved token parameter templates execute while local history stores redacted argv", async () => {
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
    expect(
      await new AuditJournal(
        join(dir, "control-plane", "audit.jsonl"),
        join(dir, "control-plane", "audit.anchor"),
      ).read(),
    ).toEqual([]);
    const entries = await readLocalCommandHistory(inventoryPath);
    if (process.getuid?.() === 0) expect(entries).toEqual([]);
    else {
      const history = JSON.stringify(entries);
      expect(history).toContain("--token=[REDACTED]");
      expect(history).not.toContain(secretValue);
    }
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
    expect(
      await new AuditJournal(
        join(dir, "control-plane", "audit.jsonl"),
        join(dir, "control-plane", "audit.anchor"),
      ).read(),
    ).toEqual([]);
    const entries = await readLocalCommandHistory(inventoryPath);
    if (process.getuid?.() === 0) expect(entries).toEqual([]);
    else {
      const history = JSON.stringify(entries);
      expect(history).toContain(parameterValue);
      expect(history).not.toContain("{{unit}}");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secret-flagged saved parameters stay masked in plans, errors, and local history", async () => {
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
    expect(
      await new AuditJournal(
        join(dir, "control-plane", "audit.jsonl"),
        join(dir, "control-plane", "audit.anchor"),
      ).read(),
    ).toEqual([]);
    const entries = await readLocalCommandHistory(inventoryPath);
    if (process.getuid?.() === 0) expect(entries).toEqual([]);
    else {
      const history = JSON.stringify(entries);
      expect(history).not.toContain(secretValue);
      expect(history).toContain("[REDACTED]");
    }
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
