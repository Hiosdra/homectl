import { join } from "node:path";
import { run } from "./process";
import { repoRoot } from "./setup";
import { HomectlError, type Runner } from "./types";

export async function update(dryRun = false, runner: Runner = run) {
  const actions = [
    "Require a clean checkout on a branch with an upstream",
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
        "Update Git operation failed; check Git installation, upstream access and branch state",
      );
    return result.stdout.trim();
  };
  if (await git(["status", "--porcelain"]))
    throw new HomectlError(
      3,
      "Update requires a clean checkout; commit or move your local changes first",
    );
  await git(["symbolic-ref", "--quiet", "HEAD"]);
  await git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  const before = await git(["rev-parse", "HEAD"]);
  await git(["pull", "--ff-only"]);
  const revision = await git(["rev-parse", "HEAD"]);
  const install = await runner({
    argv: [process.execPath, "--cwd", repoRoot, "install", "--frozen-lockfile"],
    timeoutMs: 300_000,
  });
  if (install.exitCode)
    throw new HomectlError(
      5,
      "Source updated, but dependency installation failed; run bun install --frozen-lockfile in the checkout and retry setup",
    );
  const setup = await runner({
    argv: [process.execPath, join(repoRoot, "src", "cli", "main.ts"), "setup"],
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
    actions,
    next: "Restart running homectl serve processes to use the update. On Windows, restart your terminal application to load user PATH changes.",
  };
}
