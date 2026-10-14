import { join } from "node:path";
import { run } from "./process";
import { repoRoot } from "./setup";
import { HomectlError, type Runner } from "./types";

export async function update(dryRun = false, runner: Runner = run) {
  const actions = [
    "Check the current branch and its upstream",
    "Fast-forward the current branch from its configured upstream",
    "Install dependencies from the frozen lockfile",
    "Refresh the per-user installation with the updated setup",
  ];
  if (dryRun) return { actions };
  const git = async (args: string[]) => {
    const result = await runner({ argv: ["git", "-C", repoRoot, ...args] });
    if (result.exitCode)
      throw new HomectlError(
        5,
        "Git refused the update; check upstream access, divergent history, or local changes overlapping incoming files. Local changes were not stashed or discarded",
      );
    return result.stdout.trim();
  };
  await git(["symbolic-ref", "--quiet", "HEAD"]);
  await git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const before = await git(["rev-parse", "HEAD"]);
  await git(["pull", "--ff-only"]);
  const revision = await git(["rev-parse", "HEAD"]);
  const install = await runner({
    argv: [process.execPath, "install", "--cwd", repoRoot, "--frozen-lockfile"],
    timeoutMs: 300_000,
  });
  if (install.exitCode)
    throw new HomectlError(
      5,
      "Source updated, but dependency installation failed; run bun install --frozen-lockfile in the checkout and retry setup",
    );
  const setup = await runner({
    argv: [
      process.execPath,
      join(repoRoot, "src", "cli", "main.ts"),
      "setup",
      "--json",
    ],
    timeoutMs: 120_000,
  });
  if (setup.exitCode)
    throw new HomectlError(
      5,
      "Source and dependencies updated, but setup failed; run setup directly to inspect the error",
    );
  return {
    updated: before !== revision,
    revision,
    actions: [
      "Branch and upstream checked",
      before === revision
        ? "Source already up to date"
        : "Source updated by fast-forward",
      "Dependencies verified from the frozen lockfile",
      "Local installation refreshed",
    ],
    next: "Restart running homectl serve processes to use the update. On Windows, restart your terminal application to load user PATH changes.",
  };
}
