// `home-ctl daemon run|status|install|uninstall`.
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callBroker, findEndpoint } from "../broker/client";
import { hardenedSupport } from "../broker/hardened-support";
import { assertRoot, installPlan, uninstallPlan } from "../broker/install";
import {
  isWindowsAdmin,
  runElevatedWindows,
  windowsElevationNotice,
  windowsOwnershipStep,
} from "../broker/install-windows";
import { compatPaths, hardenedPaths } from "../broker/paths";
import { windowsCscPath } from "../broker/windows-service-host";
import type { ReviewerAuthority } from "../core/contracts";
import { run } from "../process";
import { readPassword } from "../session";
import { HomectlError } from "../types";
import { confirm } from "./prompts";

type Emit = (value: unknown, human?: string) => void;

function selfExecutable(): string[] {
  // Compiled binary: the executable itself; source checkout: bun + main.ts.
  return process.execPath.endsWith("bun") ||
    process.execPath.endsWith("bun.exe")
    ? [process.execPath, join(import.meta.dir, "main.ts")]
    : [process.execPath];
}

async function systemdRunning(): Promise<boolean> {
  try {
    return (
      (await run({ argv: ["test", "-d", "/run/systemd/system"] })).exitCode ===
      0
    );
  } catch {
    return false;
  }
}

export async function daemonCommand(
  positionals: string[],
  options: {
    inventoryPath: string;
    sshConfigPath: string;
    mode?: string;
    dryRun: boolean;
    emit: Emit;
  },
): Promise<number> {
  const [action] = positionals;
  const mode = options.mode ?? "compat";
  if (mode !== "compat" && mode !== "hardened")
    throw new HomectlError(2, "--mode is compat or hardened");
  switch (action) {
    case "run": {
      const paths =
        mode === "hardened"
          ? hardenedPaths()
          : compatPaths(options.inventoryPath);
      const inventoryPath =
        mode === "hardened"
          ? join(paths.state, "workspace", "inventory.yaml")
          : options.inventoryPath;
      const { startDaemon } = await import("../broker/daemon");
      const { workspaceFromEnv } = await import("../workspace/wiring");
      const workspace = workspaceFromEnv();
      const daemon = await startDaemon({
        mode,
        ...paths,
        inventoryPath,
        sshConfigPath:
          mode === "hardened"
            ? join(dirname(inventoryPath), "ssh_config")
            : options.sshConfigPath,
        ...(workspace ? { workspace } : {}),
        ...(process.env.HOMECTL_PANEL_ORIGIN
          ? { panelOrigin: process.env.HOMECTL_PANEL_ORIGIN }
          : {}),
      });
      // Hardened: agents of any local user may connect; the token is the check.
      if (mode === "hardened" && paths.listen.kind === "unix")
        await chmod(paths.listen.path, 0o666);
      if (!(await daemon.verifier.exists()))
        console.error(
          "No owner password is set yet; approvals are impossible until `home-ctl owner init` (compat) or `home-ctl daemon install` (hardened).",
        );
      options.emit(
        { running: true, mode, address: daemon.endpoint.address },
        `homectl broker running (${mode}) on ${daemon.endpoint.address}. Press Ctrl+C to stop.`,
      );
      await new Promise<void>((resolve) => {
        const stop = () => void daemon.stop().then(resolve);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    case "panel": {
      // The owner web panel. It needs the broker started with the same
      // origin in HOMECTL_PANEL_ORIGIN, or the broker refuses its sign-in.
      const { startOwnerPanel } = await import("../web/owner/server");
      const port = Number(process.env.HOMECTL_OWNER_PANEL_PORT ?? 7451);
      const panel = await startOwnerPanel({
        inventoryPath: options.inventoryPath,
        port,
      });
      options.emit(
        { running: true, origin: panel.origin },
        `Owner panel on ${panel.origin}. Start the broker with HOMECTL_PANEL_ORIGIN=${panel.origin} so it accepts this panel. Press Ctrl+C to stop.`,
      );
      await new Promise<void>((resolve) => {
        const stop = () => {
          panel.stop();
          resolve();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    case "status": {
      const endpoint = await findEndpoint(options.inventoryPath);
      if (!endpoint) {
        options.emit({ running: false }, "The homectl broker is not running.");
        return 5;
      }
      const reachable = await callBroker(
        "/v1/whoami",
        {},
        { endpoint, timeoutMs: 3000 },
      )
        .then(() => true)
        .catch((error: HomectlError) => /Client token/.test(error.message));
      // Says per platform what hardened mode gives here, whichever mode is running.
      const hardened = hardenedSupport(
        process.platform,
        process.platform === "linux" && (await systemdRunning()),
      );
      options.emit(
        {
          running: reachable,
          mode: endpoint.mode,
          address: endpoint.address,
          hardened,
        },
        [
          reachable
            ? `homectl broker is running (${endpoint.mode}${endpoint.mode === "compat" ? ", weaker: same user as the owner" : ""}).`
            : "The endpoint file exists but the broker does not answer.",
          hardened.statement,
        ].join("\n"),
      );
      return reachable ? 0 : 5;
    }
    case "install":
    case "uninstall": {
      const isWin = process.platform === "win32";
      const plan =
        action === "install"
          ? installPlan({
              platform: process.platform,
              executable: selfExecutable(),
              workspace: dirname(options.inventoryPath),
              systemd: process.platform === "linux" && (await systemdRunning()),
              ...(isWin
                ? {
                    cscAvailable: await Bun.file(windowsCscPath()).exists(),
                    ...(process.env.HOMECTL_PANEL_ORIGIN
                      ? { panelOrigin: process.env.HOMECTL_PANEL_ORIGIN }
                      : {}),
                  }
                : {}),
            })
          : {
              supported:
                process.platform === "linux" || process.platform === "win32",
              reasons:
                process.platform === "linux" || process.platform === "win32"
                  ? []
                  : [
                      "Hardened daemon uninstall is supported on Linux and Windows only.",
                    ],
              steps: uninstallPlan(process.platform),
            };
      if (!plan.supported) {
        options.emit(plan, plan.reasons.join("\n"));
        return 3;
      }
      if (options.dryRun) {
        options.emit(
          plan,
          plan.steps
            .map((s) => `- ${s.description}\n    ${s.argv.join(" ")}`)
            .join("\n"),
        );
        return 0;
      }
      if (isWin && !isWindowsAdmin() && process.stdin.isTTY) {
        console.log(windowsElevationNotice(action));
        if (
          !(await confirm(
            "Continue and open the Windows administrator prompt (UAC)?",
          ))
        )
          throw new HomectlError(
            3,
            "Cancelled before requesting administrator permission.",
          );
        console.error(
          `Requesting administrator permission (UAC) to ${action} the homectl Windows service…`,
        );
        const elevated = runElevatedWindows([
          ...selfExecutable(),
          "daemon",
          action,
          "--inventory",
          options.inventoryPath,
        ]);
        if (elevated.cancelled)
          throw new HomectlError(
            3,
            "Administrator permission was cancelled (UAC). Accept the prompt to continue.",
          );
        if (elevated.exitCode !== 0) return elevated.exitCode;
        options.emit(
          { done: action, elevated: true },
          `homectl broker ${action === "install" ? "installed and started" : "removed"}.`,
        );
        return 0;
      }
      assertRoot();
      // On Windows, create owner.json/policy.json before starting the service so
      // protect() does not strip Administrators before the installer writes them.
      const deferLastStep =
        action === "install" && isWin && plan.steps.length > 0;
      const mainSteps = deferLastStep ? plan.steps.slice(0, -1) : plan.steps;
      const finalStep = deferLastStep ? plan.steps.at(-1) : undefined;
      const runStep = async (step: (typeof plan.steps)[number]) => {
        if (step.skipIf && (await run({ argv: step.skipIf })).exitCode === 0)
          return;
        const result = await run({
          argv: step.argv,
          ...(step.stdin ? { stdin: step.stdin } : {}),
        });
        if (result.exitCode !== 0 && !step.ignoreFailure) {
          const detail = (result.stderr || result.stdout).trim().slice(0, 400);
          throw new HomectlError(
            5,
            `Step failed: ${step.description}. Nothing after it ran.${detail ? `\n${detail}` : ""}`,
            {
              step: step.argv,
            },
          );
        }
      };
      for (const step of mainSteps) await runStep(step);
      let reviewerAuthority: ReviewerAuthority | undefined;
      if (action === "install") {
        const { FileVerifier } = await import("../broker/owner");
        const state = hardenedPaths().state;
        const verifier = new FileVerifier(join(state, "owner.json"));
        // A vault taken into custody makes its master password the owner
        // password; a separate one is only needed without a vault.
        const custodyVault = join(state, "workspace", "homelab.kdbx");
        if (
          !(await verifier.exists()) &&
          !(await Bun.file(custodyVault).exists())
        ) {
          const first = await readPassword("New homectl owner password: ");
          if (first !== (await readPassword("Repeat it: ")))
            throw new HomectlError(2, "The passwords do not match");
          await verifier.set(first);
          // The same reviewer authority choice as `owner init`; recommend is the default.
          const { chooseReviewerAuthority, saveReviewerAuthority } =
            await import("./owner-commands");
          reviewerAuthority = await chooseReviewerAuthority();
          const savedPolicy = await saveReviewerAuthority(
            state,
            reviewerAuthority,
          );
          if (isWin) {
            if (savedPolicy)
              await runStep(windowsOwnershipStep(join(state, "policy.json")));
            await runStep(windowsOwnershipStep(join(state, "owner.json")));
          } else {
            if (savedPolicy)
              await run({
                argv: ["chown", "homectl:homectl", join(state, "policy.json")],
              });
            await run({
              argv: ["chown", "homectl:homectl", join(state, "owner.json")],
            });
          }
        }
      }
      if (finalStep) await runStep(finalStep);
      options.emit(
        { done: action, ...(reviewerAuthority ? { reviewerAuthority } : {}) },
        `homectl broker ${action === "install" ? "installed and started" : "removed"}.${reviewerAuthority ? ` Reviewer authority: ${reviewerAuthority}.` : ""}`,
      );
      return 0;
    }
    default:
      throw new HomectlError(
        2,
        "Usage: home-ctl daemon run|panel|status|install|uninstall [--mode compat|hardened]",
      );
  }
}
