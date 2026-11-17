import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("keeps synced copy names within the limit and deduplicates them", async () => {
    const dir = await directory();
    try {
      const store = new SavedCommandStore(join(dir, "saved-commands.json"));
      const original = await store.save({ ...template, name: "n".repeat(80) });
      const copies = savedCommandsFromRecords({
        [`saved-command:copy-${original.id}`]: { value: original },
        [`saved-command:copy-${original.id}-2`]: { value: original },
      });
      expect(copies).toHaveLength(2);
      expect(copies.every((command) => command.name.length <= 80)).toBe(true);
      expect(
        new Set(copies.map((command) => command.name.toLowerCase())).size,
      ).toBe(2);
      await store.replaceFromRecords(
        Object.fromEntries(
          copies.map((command) => [
            `saved-command:${command.id}`,
            { value: command },
          ]),
        ),
      );
      expect(await store.list()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips and reports one invalid stored record without hiding valid ones", async () => {
    const dir = await directory();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const path = join(dir, "saved-commands.json");
      const store = new SavedCommandStore(path);
      const valid = await store.save(template);
      const invalid = { ...valid, id: "broken", name: "x".repeat(81) };
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          commands: {
            [valid.id]: valid,
            broken: invalid,
          },
        }),
      );
      expect((await store.list()).map((command) => command.id)).toEqual([
        valid.id,
      ]);
      expect(await store.listWithIssues()).toMatchObject({
        invalid: [{ id: "broken", status: "invalid" }],
      });
      await store.save({ ...template, name: "A second valid command" });
      const disk = JSON.parse(await readFile(path, "utf8")) as {
        commands: Record<string, unknown>;
      };
      expect(disk.commands.broken).toEqual(invalid);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("allows password placeholders but refuses redaction markers", async () => {
    const dir = await directory();
    try {
      const store = new SavedCommandStore(join(dir, "saved-commands.json"));
      for (const argv of [
        ["tool", "--password={{pw}}"],
        ["tool", "PASSWORD={{pw}}"],
      ])
        await store.save({
          ...template,
          name: `Placeholder ${argv[1]}`,
          argv,
          parameters: [{ name: "pw" }],
        });
      await expect(
        store.save({
          ...template,
          name: "Redacted assignment",
          argv: ["tool", "NAME=[REDACTED]"],
          parameters: [],
        }),
      ).rejects.toThrow(/redacted/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes saves from separate store instances", async () => {
    const dir = await directory();
    try {
      const path = join(dir, "saved-commands.json");
      await Promise.all([
        new SavedCommandStore(path).save({ ...template, name: "First" }),
        new SavedCommandStore(path).save({ ...template, name: "Second" }),
      ]);
      expect(
        (await new SavedCommandStore(path).list()).map((item) => item.name),
      ).toEqual(["First", "Second"]);
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

test("command audit events normalize invalid argv before journaling", async () => {
  const dir = await directory();
  try {
    const inventoryPath = join(dir, "inventory.yaml");
    const options = {
      configPath: join(dir, "ssh_config"),
      audit: { inventoryPath },
    };
    for (const argv of [[], [""], ["hostname", ...Array(64).fill("x")]])
      await expect(
        execute("example", machine, argv, options),
      ).rejects.toThrow();
    const journal = new AuditJournal(
      join(dir, "control-plane", "audit.jsonl"),
      join(dir, "control-plane", "audit.anchor"),
    );
    const entries = await journal.read();
    expect((await journal.verify()).ok).toBe(true);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.event.argv?.length).toBeGreaterThanOrEqual(1);
      expect(entry.event.argv?.length).toBeLessThanOrEqual(64);
      expect(entry.event.argv?.every((item) => item.length > 0)).toBe(true);
    }
    expect(entries.at(-1)?.event.argv?.at(-1)).toContain("truncated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit-write failures do not replace command results or runner errors", async () => {
  const dir = await directory();
  const controlDirectory = join(dir, "control-plane");
  try {
    const audit = { inventoryPath: join(dir, "inventory.yaml") };
    const outcome = await execute("example", machine, ["hostname"], {
      configPath: join(dir, "ssh_config"),
      audit,
      runner: async () => {
        await rm(controlDirectory, { recursive: true, force: true });
        await writeFile(controlDirectory, "not a directory");
        return { exitCode: 0, stdout: "ran once", stderr: "" };
      },
    });
    expect(outcome).toMatchObject({
      result: { exitCode: 0, stdout: "ran once" },
      auditWarning: expect.stringContaining("audit"),
    });

    await rm(controlDirectory, { force: true });
    await mkdir(controlDirectory, { recursive: true });
    const runnerError = new Error("runner failure");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        execute("example", machine, ["hostname"], {
          configPath: join(dir, "ssh_config"),
          audit,
          runner: async () => {
            await rm(controlDirectory, { recursive: true, force: true });
            await writeFile(controlDirectory, "not a directory");
            throw runnerError;
          },
        }),
      ).rejects.toBe(runnerError);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
