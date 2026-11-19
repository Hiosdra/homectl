// `home-ctl daemon run|status|install|uninstall`.
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callBroker, findEndpoint } from "../broker/client";
import { assertRoot, installPlan, uninstallPlan } from "../broker/install";
import { compatPaths, hardenedPaths } from "../broker/paths";
import { run } from "../process";
import { readPassword } from "../session";
import { HomectlError } from "../types";

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
      const daemon = await startDaemon({
        mode,
        ...paths,
        inventoryPath,
        sshConfigPath:
          mode === "hardened"
            ? join(dirname(inventoryPath), "ssh_config")
            : options.sshConfigPath,
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
      options.emit(
        { running: reachable, mode: endpoint.mode, address: endpoint.address },
        reachable
          ? `homectl broker is running (${endpoint.mode}${endpoint.mode === "compat" ? ", weaker: same user as the owner" : ""}).`
          : "The endpoint file exists but the broker does not answer.",
      );
      return reachable ? 0 : 5;
    }
    case "install":
    case "uninstall": {
      const plan =
        action === "install"
          ? installPlan({
              platform: process.platform,
              executable: selfExecutable(),
              workspace: dirname(options.inventoryPath),
              systemd: process.platform === "linux" && (await systemdRunning()),
            })
          : {
              supported: process.platform === "linux",
              reasons: [],
              steps: uninstallPlan(),
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
      assertRoot();
      for (const step of plan.steps) {
        if (step.skipIf && (await run({ argv: step.skipIf })).exitCode === 0)
          continue;
        const result = await run({
          argv: step.argv,
          ...(step.stdin ? { stdin: step.stdin } : {}),
        });
        if (result.exitCode !== 0)
          throw new HomectlError(
            5,
            `Step failed: ${step.description}. Nothing after it ran.`,
            {
              step: step.argv,
            },
          );
      }
      if (action === "install") {
        const { FileVerifier } = await import("../broker/owner");
        const verifier = new FileVerifier(
          join(hardenedPaths().state, "owner.json"),
        );
        if (!(await verifier.exists())) {
          const first = await readPassword("New homectl owner password: ");
          if (first !== (await readPassword("Repeat it: ")))
            throw new HomectlError(2, "The passwords do not match");
          await verifier.set(first);
          await run({
            argv: [
              "chown",
              "homectl:homectl",
              join(hardenedPaths().state, "owner.json"),
            ],
          });
        }
      }
      options.emit(
        { done: action },
        `homectl broker ${action === "install" ? "installed and started" : "removed"}.`,
      );
      return 0;
    }
    default:
      throw new HomectlError(
        2,
        "Usage: home-ctl daemon run|status|install|uninstall [--mode compat|hardened]",
      );
  }
}
