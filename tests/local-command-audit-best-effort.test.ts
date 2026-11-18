import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushLocalCommandHistory,
  readLocalCommandHistory,
} from "../src/command-history";
import { execute } from "../src/operations";
import type { Machine } from "../src/types";

const machine: Machine = {
  description: "Synthetic",
  transport: "local",
  access: "full",
};

async function directory() {
  return mkdtemp(join(tmpdir(), "homectl-audit-best-effort-"));
}

test("root-session refusals do not create command-history or control-plane files", async () => {
  const dir = await directory();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const inventoryPath = join(dir, "inventory.yaml");
  const historyPath = join(dir, "history", "commands.jsonl");
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
    expect(await Bun.file(historyPath).exists()).toBe(false);
    expect(await Bun.file(join(dir, "history")).exists()).toBe(false);
    expect(await Bun.file(auditPath).exists()).toBe(false);
    expect(
      await Bun.file(join(dir, "control-plane", "audit.anchor")).exists(),
    ).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("not written because homectl is running as root"),
    );
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("history-write failures do not replace command results or runner errors", async () => {
  const dir = await directory();
  const historyDirectory = join(dir, "history");
  const inventoryPath = join(dir, "inventory.yaml");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const audit = { inventoryPath };
    await writeFile(historyDirectory, "not a directory");
    const outcome = await execute("example", machine, ["hostname"], {
      configPath: join(dir, "ssh_config"),
      audit,
      runner: async () => ({ exitCode: 0, stdout: "ran once", stderr: "" }),
    });
    expect(outcome).toMatchObject({
      result: { exitCode: 0, stdout: "ran once" },
    });
    const warningCount = () =>
      warning.mock.calls.filter(
        ([message]) => message === "Could not write local command history.",
      ).length;
    await flushLocalCommandHistory(inventoryPath);
    expect(warningCount()).toBe(2);

    await rm(historyDirectory, { force: true });
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(
      join(historyDirectory, "commands.jsonl"),
      "not valid JSON\n",
    );
    const runnerError = new Error("runner failure");
    const previousWarnings = warningCount();
    await expect(
      execute("example", machine, ["hostname"], {
        configPath: join(dir, "ssh_config"),
        audit,
        runner: async () => {
          throw runnerError;
        },
      }),
    ).rejects.toBe(runnerError);
    await flushLocalCommandHistory(inventoryPath);
    expect(warningCount()).toBe(previousWarnings);
    expect(
      (await readLocalCommandHistory(inventoryPath)).map(
        (entry) => entry.status,
      ),
    ).toEqual(["executing", "unknown"]);
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
