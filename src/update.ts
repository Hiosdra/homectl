import { join } from "node:path";
import { bundled } from "./internal";
import { run } from "./process";
import { repoRoot } from "./setup";
import { HomectlError, type Runner } from "./types";

export async function update(dryRun = false, runner: Runner = run) {
  // A release executable is replaced by installing a new release, not by git pull.
  if (bundled)
    throw new HomectlError(
      2,
      "This is a compiled release. Update it by installing the newer release (package manager or release archive).",
    );
  const actions = [
    "Check the current branch and its upstream",
    "Fast-forward the current branch from its configured upstream",
    "Install dependencies from the frozen lockfile",
    "Refresh the per-user installation with the updated setup",
  ];
  if (dryRun) return { actions };
  const git = async (args: string[], failureMessage: string) => {
    const result = await runner({ argv: ["git", "-C", repoRoot, ...args] });
    if (result.exitCode) {
      const diagnostic = result.stderr.trim().split(/\r?\n/, 1)[0];
      const message =
        args[0] === "pull" &&
        /not possible to fast-forward|divergent branches|diverged/i.test(
          result.stderr,
        )
          ? "Local and upstream branches have diverged; reconcile them before updating"
          : failureMessage;
      throw new HomectlError(
        5,
        `${message}${diagnostic ? `\nGit: ${diagnostic}` : ""}`,
      );
    }
    return result.stdout.trim();
  };
  await git(
    ["symbolic-ref", "--quiet", "HEAD"],
    "Cannot update from a detached HEAD; check out a branch first",
  );
  await git(
    ["rev-parse", "--abbrev-ref", "@{upstream}"],
    "No upstream is configured for the current branch; configure one before updating",
  );
  const before = await git(
    ["rev-parse", "HEAD"],
    "Cannot read the current Git revision",
  );
  await git(
    ["pull", "--ff-only"],
    "Git could not fast-forward the current branch; check remote access and local changes",
  );
  const revision = await git(
    ["rev-parse", "HEAD"],
    "Cannot read the updated Git revision",
  );
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
    next: "Restart running home-ctl serve processes to use the update. On Windows, restart your terminal application to load user PATH changes.",
  };
}

// `home-ctl update` takes --dry-run, --rollback and --json.
export async function runUpdate(
  positionals: string[],
  commandArgs: string[],
  inventory: unknown,
  dryRun: boolean,
  values: { rollback?: boolean } = {},
) {
  if (positionals.length !== 1 || commandArgs.length || inventory)
    throw new HomectlError(
      2,
      "Usage: home-ctl update [--dry-run] [--rollback] [--json]",
    );
  if (values.rollback) {
    if (!bundled)
      throw new HomectlError(
        2,
        "--rollback applies to release builds. A source checkout reverts with git.",
      );
    if (dryRun)
      return { actions: ["Point the commands back at the earlier release"] };
    const { rollbackRelease } = await import("./update-apply");
    return rollbackRelease();
  }
  return update(dryRun);
}
