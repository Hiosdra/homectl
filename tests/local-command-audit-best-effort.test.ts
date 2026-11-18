import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/operations";
import type { Machine } from "../src/types";
import { waitFor } from "./audit-test-helpers";

const machine: Machine = {
  description: "Synthetic",
  transport: "local",
  access: "full",
};

async function directory() {
  return mkdtemp(join(tmpdir(), "homectl-audit-best-effort-"));
}

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

test("audit-write failures do not replace command results or runner errors", async () => {
  const dir = await directory();
  const controlDirectory = join(dir, "control-plane");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const audit = { inventoryPath: join(dir, "inventory.yaml") };
    await writeFile(controlDirectory, "not a directory");
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
        ([message]) =>
          message ===
          "The command ran, but its audit event could not be saved.",
      ).length;
    await waitFor(
      () => warning.mock.calls.map(([message]) => message),
      (messages) =>
        messages.includes(
          "The command is running, but its start audit event could not be saved.",
        ) &&
        messages.includes(
          "The command ran, but its audit event could not be saved.",
        ),
      "command audit failure warnings",
    );

    await rm(controlDirectory, { force: true });
    await mkdir(controlDirectory, { recursive: true });
    await writeFile(join(controlDirectory, "audit.jsonl"), "not valid JSON\n");
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
    await waitFor(
      warningCount,
      (count) => count > previousWarnings,
      "runner audit warning",
    );
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
