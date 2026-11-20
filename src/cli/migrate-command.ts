// `home-ctl migrate [--dry-run]`: the manual entry point for the workspace data
// migration in src/migrate. The broker runs the same migration when it starts
// (src/broker/daemon.ts startDaemon), so this command is for a preview with
// --dry-run, or an upgrade run before the daemon starts. It is idempotent: a
// workspace already at the current data version reports status "current".
import { migrate, type MigrationResult } from "../migrate";
import { HomectlError } from "../types";

export const MIGRATE_USAGE =
  "Usage: home-ctl migrate [--dry-run] [--inventory PATH] [--json]";

export async function migrateCommand(
  positionals: string[],
  commandArgs: string[],
  inventoryPath: string,
  dryRun: boolean,
): Promise<MigrationResult> {
  if (positionals.length > 1 || commandArgs.length)
    throw new HomectlError(2, MIGRATE_USAGE);
  return migrate(inventoryPath, { dryRun });
}
