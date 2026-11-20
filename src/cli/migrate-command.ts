// `home-ctl migrate [--dry-run]`: the manual entry point for the workspace data
// migration in src/migrate. The broker runs the same migration when it starts
// (src/broker/daemon.ts startDaemon), so this command is for a preview with
// --dry-run, or an upgrade run before the daemon starts. It is idempotent: a
// workspace already at the current data version reports status "current".
// `--mode hardened` targets the hardened broker's state, as `daemon run --mode
// hardened` does; that state belongs to the service account, so run it as an
// administrator.
import { join } from "node:path";
import { compatPaths, hardenedPaths } from "../broker/paths";
import { migrate, type MigrationResult } from "../migrate";
import { HomectlError } from "../types";

export const MIGRATE_USAGE =
  "Usage: home-ctl migrate [--dry-run] [--mode compat|hardened] [--inventory PATH] [--json]";

export type MigrateMode = "compat" | "hardened";

// The workspace (inventory) and broker state a migration uses for a mode: the
// same paths `daemon run` starts from. Hardened mode ignores --inventory.
export function migrationTarget(
  mode: MigrateMode,
  inventoryPath: string,
  platform = process.platform,
): { inventoryPath: string; brokerState: string } {
  if (mode === "hardened") {
    const { state } = hardenedPaths(platform);
    return {
      inventoryPath: join(state, "workspace", "inventory.yaml"),
      brokerState: state,
    };
  }
  return {
    inventoryPath,
    brokerState: compatPaths(inventoryPath, platform).state,
  };
}

export async function migrateCommand(
  positionals: string[],
  commandArgs: string[],
  inventoryPath: string,
  dryRun: boolean,
  mode?: string,
): Promise<MigrationResult> {
  if (positionals.length > 1 || commandArgs.length)
    throw new HomectlError(2, MIGRATE_USAGE);
  if (mode !== undefined && mode !== "compat" && mode !== "hardened")
    throw new HomectlError(2, "--mode is compat or hardened");
  const target = migrationTarget(mode ?? "compat", inventoryPath);
  return migrate(target.inventoryPath, {
    dryRun,
    brokerState: target.brokerState,
  });
}
