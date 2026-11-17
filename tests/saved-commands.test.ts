import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditHistory } from "../src/control/audit-view";
import { AuditJournal } from "../src/control/journal";
import { execute } from "../src/operations";
import {
  availableCommandHosts,
  expandSavedCommand,
  SavedCommandStore,
  savedCommandsFromRecords,
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
  return mkdtemp(join(tmpdir(), "homectl-saved-command-"));
}

describe("saved command storage", () => {
  test("persists versioned templates and expands declared parameters as argv", async () => {
    const dir = await directory();
    try {
      const store = new SavedCommandStore(join(dir, "saved-commands.json"));
      const saved = await store.save(template);
      expect(saved.schemaVersion).toBe(1);
      expect((await store.list()).map((item) => item.id)).toEqual([saved.id]);
      expect(
        expandSavedCommand(saved, "example", { unit: "nginx.service" }),
      ).toEqual(["systemctl", "restart", "nginx.service"]);
      expect(availableCommandHosts(saved, ["other"])).toEqual({
        available: [],
        unavailable: ["example"],
      });
      expect(() =>
        expandSavedCommand(saved, "other", { unit: "nginx" }),
      ).toThrow();
      await expect(
        store.save({
          ...template,
          parameters: [],
          argv: ["systemctl", "restart", "{{missing}}"],
        }),
      ).rejects.toThrow("Declare parameter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not store secret-looking arguments and rehydrates copy records", async () => {
    const dir = await directory();
    try {
      const store = new SavedCommandStore(join(dir, "saved-commands.json"));
      await expect(
        store.save({
          ...template,
          argv: ["tool", "--token", "hct_abcdefghijklmnop1234"],
          parameters: [],
        }),
      ).rejects.toThrow("Secret-like arguments");
      const original = await store.save(template);
      const copies = savedCommandsFromRecords({
        [`saved-command:copy-${original.id}`]: {
          value: original,
        },
      });
      expect(copies[0]?.id).toBe(`copy-${original.id}`);
      expect(copies[0]?.name).toBe(`${original.name} (copy)`);
      const copiedRecord = {
        [`saved-command:${copies[0]?.id}`]: { value: copies[0] },
      };
      expect(savedCommandsFromRecords(copiedRecord)[0]?.name).toBe(
        `${original.name} (copy)`,
      );
      const disk = await readFile(join(dir, "saved-commands.json"), "utf8");
      expect(disk).not.toContain("approval");
      expect(disk).not.toContain("hct_abcdefghijklmnop1234");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("saved mutation cannot bypass approval and local audit excludes output and secrets", async () => {
  const dir = await directory();
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const argv = [
      "systemctl",
      "restart",
      "nginx",
      "--token",
      "hct_abcdefghijklmnop1234",
    ];
    const audit = {
      inventoryPath,
      requester: "local-operator",
      approver: "local-operator",
    };
    const preview = await execute("example", machine, argv, {
      configPath: join(dir, "unused-ssh-config"),
      dryRun: true,
      requireApproval: true,
    });
    expect(preview.plan.classification).toBe("mutation");
    expect(preview.plan.needsApproval).toBe(true);
    const privilegedInspection = await execute(
      "example",
      machine,
      ["sudo", "-n", "systemctl", "status", "nginx"],
      {
        configPath: join(dir, "unused-ssh-config"),
        dryRun: true,
        requireApproval: true,
      },
    );
    expect(privilegedInspection.plan.classification).toBe("inspect");
    expect(privilegedInspection.plan.needsApproval).toBe(true);
    let runs = 0;
    const runner = async () => {
      runs++;
      return { exitCode: 0, stdout: "OUTPUT_MUST_NOT_ENTER_AUDIT", stderr: "" };
    };
    await expect(
      execute("example", machine, argv, {
        configPath: join(dir, "unused-ssh-config"),
        requireApproval: true,
        runner,
        audit,
      }),
    ).rejects.toMatchObject({ code: 4 });
    expect(runs).toBe(0);
    await execute("example", machine, argv, {
      configPath: join(dir, "unused-ssh-config"),
      requireApproval: true,
      approval: preview.plan.approval,
      runner,
      audit,
    });
    expect(runs).toBe(1);
    const journal = new AuditJournal(
      join(dir, "control-plane", "audit.jsonl"),
      join(dir, "control-plane", "audit.anchor"),
    );
    const entries = await journal.read();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("hct_abcdefghijklmnop1234");
    expect(serialized).not.toContain("OUTPUT_MUST_NOT_ENTER_AUDIT");
    expect(serialized).toContain("[REDACTED]");
    const history = auditHistory(entries);
    expect(history.entries.map((row) => row.status)).toEqual([
      "succeeded",
      "approval-required",
    ]);
    expect(history.entries[0]?.approver).toBe("local-operator");
    expect(history.entries[0]?.argv).toContain("[REDACTED]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
