import { expect, test } from "bun:test";
import type { Runner } from "../src/types";
import { update } from "../src/update";

test("update dry-run executes nothing", async () => {
  await update(true, async () => {
    throw new Error("must not execute");
  });
});
test("update fast-forwards before dependencies and fresh setup", async () => {
  const commands: string[][] = [];
  const runner: Runner = async ({ argv }) => {
    commands.push(argv);
    return {
      exitCode: 0,
      stdout: argv.includes("HEAD") && argv.includes("rev-parse") ? "abc" : "",
      stderr: "",
    };
  };
  const result = await update(false, runner);
  expect(result.updated).toBe(false);
  expect(commands[3]?.slice(-2)).toEqual(["pull", "--ff-only"]);
  expect(commands[5]?.[1]).toBe("install");
  expect(commands[5]?.at(-1)).toBe("--frozen-lockfile");
  expect(commands[6]?.slice(-2)).toEqual(["setup", "--json"]);
});
test("update never installs dependencies after a rejected fast-forward", async () => {
  const runner: Runner = async ({ argv }) => {
    if (argv[0] !== "git") throw new Error("must not install");
    return { exitCode: argv.includes("pull") ? 1 : 0, stdout: "", stderr: "" };
  };
  await expect(update(false, runner)).rejects.toThrow("Git could not");
});

test("update explains detached HEAD and includes Git's first diagnostic", async () => {
  await expect(
    update(false, async ({ argv }) => ({
      exitCode: argv.includes("symbolic-ref") ? 1 : 0,
      stdout: "",
      stderr: argv.includes("symbolic-ref")
        ? "fatal: not a symbolic ref\nsecond line"
        : "",
    })),
  ).rejects.toThrow(
    "Cannot update from a detached HEAD; check out a branch first\nGit: fatal: not a symbolic ref",
  );
});

test("update explains a missing upstream and includes Git's first diagnostic", async () => {
  await expect(
    update(false, async ({ argv }) => ({
      exitCode: argv.includes("@{upstream}") ? 1 : 0,
      stdout: "",
      stderr: argv.includes("@{upstream}")
        ? "fatal: no upstream configured\nsecond line"
        : "",
    })),
  ).rejects.toThrow(
    "No upstream is configured for the current branch; configure one before updating\nGit: fatal: no upstream configured",
  );
});

test("update identifies divergent branches before dependency installation", async () => {
  const commands: string[][] = [];
  await expect(
    update(false, async ({ argv }) => {
      commands.push(argv);
      const pull = argv.includes("pull");
      return {
        exitCode: pull ? 1 : 0,
        stdout: "",
        stderr: pull
          ? "fatal: Not possible to fast-forward, aborting.\nsecond line"
          : "",
      };
    }),
  ).rejects.toThrow(
    "Local and upstream branches have diverged; reconcile them before updating\nGit: fatal: Not possible to fast-forward, aborting.",
  );
  expect(commands.some((argv) => argv.includes("install"))).toBe(false);
});

test("Bun install command accepts update argument order", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "homectl-update-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      '{"name":"update-fixture","private":true}',
    );
    const child = Bun.spawn(
      [process.execPath, "install", "--cwd", dir, "--frozen-lockfile"],
      { stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stdout + stderr).not.toContain("Script not found");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update lets Git preserve unrelated local changes without stashing", async () => {
  const commands: string[][] = [];
  await update(false, async ({ argv }) => {
    commands.push(argv);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  expect(
    commands.some(
      (argv) => argv.includes("pull") && argv.includes("--ff-only"),
    ),
  ).toBe(true);
  expect(
    commands.some((argv) =>
      argv.some((arg) =>
        ["stash", "reset", "clean", "--autostash"].includes(arg),
      ),
    ),
  ).toBe(false);
});
