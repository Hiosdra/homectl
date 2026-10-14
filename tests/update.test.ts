import { expect, test } from "bun:test";
import type { Runner } from "../src/types";
import { update } from "../src/update";

test("update dry-run executes nothing", async () => {
  await update(true, async () => {
    throw new Error("must not execute");
  });
});
test("update refuses dirty checkout before fetching", async () => {
  let calls = 0;
  const runner: Runner = async () => {
    calls++;
    return { exitCode: 0, stdout: " M file", stderr: "" };
  };
  await expect(update(false, runner)).rejects.toThrow("clean checkout");
  expect(calls).toBe(1);
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
  expect(commands[4]?.slice(-2)).toEqual(["pull", "--ff-only"]);
  expect(commands[6]?.slice(-2)).toEqual(["install", "--frozen-lockfile"]);
  expect(commands[7]?.at(-1)).toBe("setup");
});
test("update never installs dependencies after a rejected fast-forward", async () => {
  const runner: Runner = async ({ argv }) => {
    if (argv[0] !== "git") throw new Error("must not install");
    return { exitCode: argv.includes("pull") ? 1 : 0, stdout: "", stderr: "" };
  };
  await expect(update(false, runner)).rejects.toThrow("Git operation failed");
});
