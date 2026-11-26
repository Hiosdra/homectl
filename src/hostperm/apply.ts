// Atomic apply, verify, rollback and revoke for homectl sudoers drop-ins.
// Every path written is /etc/sudoers.d/homectl-<user> or its dot-named temp and
// backup siblings. Files without a homectl header are never edited.
import { HomectlError } from "../types";
import {
  type DropInPlan,
  dropInBackupPath,
  dropInPath,
  dropInTempPath,
  parseManaged,
  readRemoteFile,
} from "./dropin";
import type { RemoteExec, StepReport } from "./types";
import { fileHashArgv, firstToken, runStep, sha256Hex, sudo } from "./util";

export type ApplyStatus =
  | "applied"
  | "unchanged"
  | "refused"
  | "failed-untouched"
  | "rolled-back"
  | "restore-failed"
  | "outcome-unknown";

export interface ApplyReport {
  status: ApplyStatus;
  path: string;
  steps: StepReport[];
  reason: string;
}

// Applies a reviewed plan. `expectedCurrent`, when given, is the live content
// the owner reviewed; otherwise plan.current is compared.
export async function applyGrant(
  exec: RemoteExec,
  plan: DropInPlan,
  options: { expectedCurrent?: string } = {},
): Promise<ApplyReport> {
  if (plan.path !== dropInPath(plan.user))
    throw new HomectlError(
      3,
      "Plan path is outside the homectl drop-in location",
    );
  const steps: StepReport[] = [];
  const report = (status: ApplyStatus, reason: string): ApplyReport => ({
    status,
    path: plan.path,
    steps,
    reason,
  });
  if (plan.foreign)
    return report(
      "refused",
      "existing file has no homectl header; not overwritten",
    );

  // 1) Re-read and compare with the reviewed state.
  let live: string | undefined;
  try {
    live = await readRemoteFile(exec, plan.path);
  } catch (error) {
    steps.push({
      id: "reread",
      argv: sudo(["cat", plan.path]),
      ok: false,
      detail: "exit non-zero",
    });
    return report(
      "refused",
      error instanceof Error ? error.message : "could not re-read the drop-in",
    );
  }
  steps.push({
    id: "reread",
    argv: sudo(["cat", plan.path]),
    ok: true,
    detail: "ok",
  });
  if (live !== undefined && parseManaged(live) === undefined)
    return report(
      "refused",
      "live file has no homectl header; not overwritten",
    );
  const expected = options.expectedCurrent ?? plan.current;
  if (live !== expected)
    return report(
      "refused",
      "drift: the file changed since the preview; re-run planGrant",
    );

  if (live === plan.desired)
    return report(
      "unchanged",
      "live drop-in already matches the desired content",
    );

  const tmp = dropInTempPath(plan.user);
  const bak = dropInBackupPath(plan.user);
  const cleanupTemp = async (): Promise<void> => {
    await runStep(exec, steps, "remove-temp", sudo(["rm", "-f", tmp]));
  };

  // 2) Write the candidate beside the target. Content arrives on stdin only.
  const written = await runStep(
    exec,
    steps,
    "write-temp",
    sudo([
      "install",
      "-m",
      "0440",
      "-o",
      "root",
      "-g",
      plan.group,
      "/dev/stdin",
      tmp,
    ]),
    plan.desired,
  );
  if (!written.ok) {
    await cleanupTemp();
    return report(
      "failed-untouched",
      "could not write the candidate; live file untouched",
    );
  }

  // 3) Validate the candidate before it can take effect.
  const candidate = await runStep(
    exec,
    steps,
    "check-temp",
    sudo(["visudo", "-cf", tmp]),
  );
  if (!candidate.ok) {
    await cleanupTemp();
    return report(
      "failed-untouched",
      "visudo rejected the candidate; live file untouched",
    );
  }

  // 4) Keep the current file so that a later failure can be undone.
  if (plan.current !== undefined) {
    const backedUp = await runStep(
      exec,
      steps,
      "backup-current",
      sudo(["cp", "-p", plan.path, bak]),
    );
    if (!backedUp.ok) {
      await cleanupTemp();
      return report(
        "failed-untouched",
        "could not back up the current drop-in; live file untouched",
      );
    }
  }

  try {
    // 5) Atomic rename within /etc/sudoers.d.
    const swapped = await runStep(
      exec,
      steps,
      "swap",
      sudo(["mv", "-f", tmp, plan.path]),
    );
    if (!swapped.ok) {
      await cleanupTemp();
      return report(
        "failed-untouched",
        "could not move the candidate into place",
      );
    }

    const rollback = async (why: string): Promise<ApplyReport> => {
      const restored =
        plan.current === undefined
          ? await runStep(
              exec,
              steps,
              "remove-new",
              sudo(["rm", "-f", plan.path]),
            )
          : await runStep(
              exec,
              steps,
              "restore-backup",
              sudo(["mv", "-f", bak, plan.path]),
            );
      const syntax = await runStep(
        exec,
        steps,
        "visudo-after-restore",
        sudo(["visudo", "-c"]),
      );
      if (restored.ok && syntax.ok)
        return report("rolled-back", `${why}; previous state restored`);
      return report(
        "restore-failed",
        `${why}; restoring the previous state failed; review ${plan.path} and ${bak} manually`,
      );
    };

    // 6) Validate the whole configuration as installed.
    const installed = await runStep(
      exec,
      steps,
      "visudo-check",
      sudo(["visudo", "-c"]),
    );
    if (!installed.ok)
      return await rollback("visudo rejected the installed configuration");

    // 7) Verify the bytes on disk and that sudo loads rules for the user.
    const sum = await runStep(
      exec,
      steps,
      "verify-hash",
      sudo(fileHashArgv(plan.os, plan.path)),
    );
    if (!sum.ok || firstToken(sum.stdout) !== plan.desiredSha256)
      return await rollback("the installed file hash did not match");
    const listed = await runStep(
      exec,
      steps,
      "verify-sudo-list",
      sudo(["-l", "-U", plan.user]),
    );
    if (!listed.ok)
      return await rollback("sudo could not list the user's privileges");

    if (plan.current !== undefined)
      await runStep(exec, steps, "remove-backup", sudo(["rm", "-f", bak]));
    return report("applied", `installed ${plan.path}`);
  } catch {
    return report(
      "outcome-unknown",
      `Connection or execution failed during the change. Inspect ${plan.path} and ${bak} before retrying.`,
    );
  }
}

export type RevokeStatus =
  | "absent"
  | "refused"
  | "removed"
  | "failed-untouched"
  | "rolled-back"
  | "restore-failed"
  | "outcome-unknown";

export interface RevokeReport {
  status: RevokeStatus;
  path: string;
  steps: StepReport[];
  reason: string;
}

// Removes only a file that carries a homectl header.
export async function revokeGrant(
  exec: RemoteExec,
  user: string,
): Promise<RevokeReport> {
  const path = dropInPath(user);
  const bak = dropInBackupPath(user);
  const steps: StepReport[] = [];
  const report = (status: RevokeStatus, reason: string): RevokeReport => ({
    status,
    path,
    steps,
    reason,
  });

  let live: string | undefined;
  try {
    live = await readRemoteFile(exec, path);
  } catch (error) {
    return report(
      "refused",
      error instanceof Error ? error.message : "could not read the drop-in",
    );
  }
  if (live === undefined) return report("absent", "no homectl drop-in present");
  const managed = parseManaged(live);
  if (!managed)
    return report("refused", "file has no homectl header; not removed");
  const modified = managed.sha256 !== sha256Hex(managed.body);

  const backedUp = await runStep(
    exec,
    steps,
    "backup-current",
    sudo(["cp", "-p", path, bak]),
  );
  if (!backedUp.ok)
    return report(
      "failed-untouched",
      "could not back up the drop-in; nothing removed",
    );
  try {
    const removed = await runStep(
      exec,
      steps,
      "remove",
      sudo(["rm", "-f", path]),
    );
    if (!removed.ok)
      return report("failed-untouched", "could not remove the drop-in");

    const rollback = async (why: string): Promise<RevokeReport> => {
      const restored = await runStep(
        exec,
        steps,
        "restore-backup",
        sudo(["mv", "-f", bak, path]),
      );
      const syntax = await runStep(
        exec,
        steps,
        "visudo-after-restore",
        sudo(["visudo", "-c"]),
      );
      if (restored.ok && syntax.ok)
        return report("rolled-back", `${why}; drop-in restored`);
      return report(
        "restore-failed",
        `${why}; restoring ${path} failed; review ${bak} manually`,
      );
    };

    const validated = await runStep(
      exec,
      steps,
      "visudo-check",
      sudo(["visudo", "-c"]),
    );
    if (!validated.ok)
      return await rollback(
        "visudo rejected the configuration without the drop-in",
      );
    const gone = await runStep(
      exec,
      steps,
      "verify-absent",
      sudo(["test", "!", "-e", path, "-a", "!", "-L", path]),
    );
    if (!gone.ok)
      return report(
        "outcome-unknown",
        `Could not verify that ${path} is absent. Inspect it and the backup at ${bak} before retrying.`,
      );

    await runStep(exec, steps, "remove-backup", sudo(["rm", "-f", bak]));
    return report(
      "removed",
      modified
        ? `removed ${path} (file had been modified since it was installed)`
        : `removed ${path}`,
    );
  } catch {
    return report(
      "outcome-unknown",
      `Connection or execution failed during the change. Inspect ${path} and ${bak} before retrying.`,
    );
  }
}
