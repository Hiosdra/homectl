// Versioned, transactional workspace migration (0.3.0, homelab #21 §3).
//
// A workspace is the directory holding the inventory. Its data version lives
// in `homectl-data.json`; a workspace without it but with 0.2 files is version
// 2. A migration:
//   1. takes the workspace migration lock and re-checks the version,
//   2. backs up every file the chain declares it may touch (private, hashed),
//   3. records progress, then runs and verifies each step in order,
//   4. checks that no undeclared file changed,
//   5. writes the version marker last.
// Any failure restores the backup, so the workspace is either fully migrated
// or exactly as it was. An interrupted run is rolled back before the next try.
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { compatPaths } from "../broker/paths";
import { withFileLock } from "../control/file-lock";
import { privateDirectory } from "../platform";
import { HomectlError } from "../types";
import {
  BACKUP_DIRECTORY,
  backupPaths,
  captureWorkspace,
  isInside,
  PROGRESS_FILE,
  restoreBackup,
  toPosix,
  writeFileAtomic,
} from "./files";
import { STEPS } from "./steps";
import type {
  Marker,
  MigrationContext,
  MigrationResult,
  MigrationStep,
  PlannedStep,
} from "./types";

export type {
  Marker,
  MarkerHistory,
  MigrationContext,
  MigrationResult,
  MigrationStep,
  PlannedStep,
} from "./types";

export const DATA_VERSION = 3;
export const MARKER_FILE = "homectl-data.json";

// Workspace entries that identify a 0.2 install when no marker exists.
export const WORKSPACE_ENTRIES = [
  MARKER_FILE,
  "control-plane",
  "peers.json",
  "peers-saved-commands.json",
  "saved-commands.json",
  "history",
  "known_hosts",
  "public-keys",
  "serve",
  "setup-preferences.json",
  "ssh_config",
] as const;

export interface MigrateOptions {
  dryRun?: boolean;
  clock?: () => number;
  steps?: readonly MigrationStep[];
  // Broker state directory. Defaults to the compat location beside the
  // inventory; the daemon passes its own state directory.
  brokerState?: string;
}

interface Progress {
  from: number;
  to: number;
  backup: string;
  touched: string[];
  completed: string[];
}

export function workspaceOf(inventoryPath: string): string {
  return dirname(resolve(inventoryPath));
}

async function present(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HomectlError(5, `${basename(path)} is corrupt; restore it first`);
  }
}

const writeJson = (path: string, value: unknown) =>
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

function entriesFor(inventoryPath: string): string[] {
  const inventory = basename(resolve(inventoryPath));
  return [inventory, `${inventory}.ssh_config`, ...WORKSPACE_ENTRIES];
}

// 0 = empty workspace, 2 = legacy 0.2.x, otherwise the marker's version.
export async function detectVersion(inventoryPath: string): Promise<number> {
  const workspace = workspaceOf(inventoryPath);
  const marker = await readJson<Marker>(join(workspace, MARKER_FILE));
  if (marker) {
    if (!Number.isSafeInteger(marker.data_version) || marker.data_version < 3)
      throw new HomectlError(5, `${MARKER_FILE} has an invalid data_version`);
    return marker.data_version;
  }
  for (const entry of entriesFor(inventoryPath))
    if (await present(join(workspace, entry))) return 2;
  return 0;
}

// The chain runs hop by hop. Steps with the same from/to form one hop, and
// hops must connect (each starts where the previous one ended). Steps of
// hops before `from` are skipped.
export function pendingSteps(
  from: number,
  steps: readonly MigrationStep[] = STEPS,
): MigrationStep[] {
  const chain: MigrationStep[] = [];
  let hopFrom = from;
  let hopTo: number | undefined;
  for (const step of steps) {
    if (step.from === hopFrom && (hopTo === undefined || step.to === hopTo)) {
      chain.push(step);
      hopTo = step.to;
    } else if (hopTo !== undefined && step.from === hopTo) {
      hopFrom = hopTo;
      hopTo = step.to;
      chain.push(step);
    } else if (step.from >= hopFrom) {
      throw new HomectlError(
        5,
        `Migration chain has a gap at v${hopTo ?? hopFrom}`,
      );
    }
    // Otherwise the step belongs to a hop before `from`: already applied.
  }
  if (from > 0 && from < DATA_VERSION && (hopTo ?? from) !== DATA_VERSION)
    throw new HomectlError(
      5,
      `No migration path from data version ${from} to ${DATA_VERSION}`,
    );
  return chain;
}

function makeContext(
  inventoryPath: string,
  brokerState: string,
  now: number,
  notes: string[],
): MigrationContext {
  return {
    workspace: workspaceOf(inventoryPath),
    inventoryPath: resolve(inventoryPath),
    brokerState,
    now,
    note: (message) => notes.push(message),
  };
}

// Display name for a path a step touches: workspace-relative, or under the
// broker state directory when it lives elsewhere.
function displayName(context: MigrationContext, path: string): string {
  if (isInside(context.workspace, path))
    return toPosix(relative(context.workspace, path));
  if (isInside(context.brokerState, path))
    return `broker-state/${toPosix(relative(context.brokerState, path))}`;
  return basename(path);
}

async function touchedBy(
  chain: readonly MigrationStep[],
  context: MigrationContext,
): Promise<string[]> {
  const paths: string[] = [];
  for (const step of chain)
    for (const path of await step.touches(context))
      if (!paths.includes(path)) paths.push(path);
  return paths;
}

function declaredSet(
  workspace: string,
  touched: readonly string[],
): Set<string> {
  return new Set(
    touched
      .filter((path) => isInside(workspace, path))
      .map((path) => toPosix(relative(workspace, path))),
  );
}

// Files outside the declared set that differ from `before`, changed or new.
async function undeclaredChanges(
  workspace: string,
  before: Record<string, Buffer>,
  touched: readonly string[],
): Promise<{ changed: string[]; created: string[] }> {
  const after = await captureWorkspace(workspace);
  const declared = declaredSet(workspace, touched);
  return {
    changed: Object.entries(before)
      .filter(
        ([rel, bytes]) => !declared.has(rel) && !after[rel]?.equals(bytes),
      )
      .map(([rel]) => rel),
    created: Object.keys(after).filter(
      (rel) => !(rel in before) && !declared.has(rel),
    ),
  };
}

// Fails when a file outside the declared set changed, appeared or vanished.
async function checkUntouched(
  workspace: string,
  before: Record<string, Buffer>,
  touched: readonly string[],
): Promise<void> {
  const { changed, created } = await undeclaredChanges(
    workspace,
    before,
    touched,
  );
  const names = [...changed, ...created];
  if (names.length)
    throw new HomectlError(
      5,
      `Migration changed files it does not declare: ${names.join(", ")}`,
    );
}

// Undoes writes outside the declared set: changed files get their captured
// bytes back, new files are removed. Declared files come from the backup.
async function restoreUndeclared(
  workspace: string,
  before: Record<string, Buffer>,
  touched: readonly string[],
): Promise<void> {
  const { changed, created } = await undeclaredChanges(
    workspace,
    before,
    touched,
  );
  for (const rel of changed) {
    const original = before[rel];
    if (original) await writeFileAtomic(join(workspace, rel), original);
  }
  for (const rel of created) await rm(join(workspace, rel), { force: true });
}

// Rolls back a run that was interrupted (its progress file is still there).
async function rollbackInterrupted(
  workspace: string,
  progressPath: string,
): Promise<void> {
  const progress = await readJson<Progress>(progressPath);
  if (progress) {
    const backups = join(workspace, BACKUP_DIRECTORY);
    if (!isInside(backups, progress.backup))
      throw new HomectlError(
        5,
        `${PROGRESS_FILE} points outside the workspace backups; check it before continuing`,
      );
    await restoreBackup(progress.backup);
  }
  await rm(progressPath, { force: true });
}

async function runLocked(
  inventoryPath: string,
  brokerState: string,
  clock: () => number,
  steps: readonly MigrationStep[],
): Promise<MigrationResult> {
  const workspace = workspaceOf(inventoryPath);
  const now = clock();
  // Re-check under the lock: another process may have finished first.
  const version = await detectVersion(inventoryPath);
  if (version === DATA_VERSION) return { status: "current", version };
  const markerPath = join(workspace, MARKER_FILE);
  if (version === 0) {
    await writeJson(markerPath, { data_version: DATA_VERSION, history: [] });
    return { status: "initialized", version: DATA_VERSION };
  }
  const notes: string[] = [];
  const progressPath = join(workspace, PROGRESS_FILE);
  if (await present(progressPath)) {
    await rollbackInterrupted(workspace, progressPath);
    notes.push("An interrupted migration was rolled back before this run");
  }
  const context = makeContext(inventoryPath, brokerState, now, notes);
  const chain = pendingSteps(version, steps);
  const touched = [markerPath, ...(await touchedBy(chain, context))];
  const before = await captureWorkspace(workspace);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const backup = join(
    workspace,
    BACKUP_DIRECTORY,
    `migration-v${version}-${stamp}-${randomUUID().slice(0, 8)}`,
  );
  await backupPaths(backup, touched, {
    from: version,
    to: DATA_VERSION,
    created: new Date(now).toISOString(),
  });
  const progress: Progress = {
    from: version,
    to: DATA_VERSION,
    backup,
    touched,
    completed: [],
  };
  await writeJson(progressPath, progress);
  let failedStep: string | undefined;
  try {
    for (const step of chain) {
      failedStep = step.id;
      await step.run(context);
      await step.verify(context);
      progress.completed.push(step.id);
      await writeJson(progressPath, progress);
    }
    await checkUntouched(workspace, before, touched);
    const previous = await readJson<Marker>(markerPath);
    await writeJson(markerPath, {
      data_version: DATA_VERSION,
      history: [
        ...(previous?.history ?? []),
        {
          from: version,
          to: DATA_VERSION,
          at: new Date(now).toISOString(),
          backup: toPosix(relative(workspace, backup)),
          steps: chain.map((step) => step.id),
        },
      ],
    } satisfies Marker);
  } catch (error) {
    try {
      await restoreUndeclared(workspace, before, touched);
      await restoreBackup(backup);
    } catch {
      // Keep the progress file: the next run restores from the same backup.
      throw new HomectlError(
        5,
        `Migration failed and the rollback did not verify; keep ${backup} and restore it before using homectl`,
        { step: failedStep },
      );
    }
    await rm(progressPath, { force: true });
    throw new HomectlError(
      5,
      `Migration to data version ${DATA_VERSION} failed and was rolled back; the workspace is unchanged (backup: ${toPosix(relative(workspace, backup))})`,
      {
        step: failedStep,
        reason: error instanceof Error ? error.message : undefined,
      },
    );
  }
  await rm(progressPath, { force: true });
  return {
    status: "migrated",
    from: version,
    to: DATA_VERSION,
    backup,
    steps: chain.map((step) => step.id),
    notes,
  };
}

export async function migrate(
  inventoryPath: string,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const workspace = workspaceOf(inventoryPath);
  const clock = options.clock ?? Date.now;
  const steps = options.steps ?? STEPS;
  const brokerState = resolve(
    options.brokerState ?? compatPaths(inventoryPath).state,
  );
  const from = await detectVersion(inventoryPath);
  if (from > DATA_VERSION)
    throw new HomectlError(
      5,
      `This workspace was written by a newer homectl (data version ${from}); update homectl instead of downgrading`,
    );
  if (from === DATA_VERSION) return { status: "current", version: from };
  if (options.dryRun) {
    if (from === 0)
      return { status: "planned", from, to: DATA_VERSION, steps: [] };
    const context = makeContext(inventoryPath, brokerState, clock(), []);
    const planned: PlannedStep[] = [];
    for (const step of pendingSteps(from, steps))
      planned.push({
        id: step.id,
        description: step.description,
        touches: (await step.touches(context)).map((path) =>
          displayName(context, path),
        ),
      });
    return { status: "planned", from, to: DATA_VERSION, steps: planned };
  }
  await privateDirectory(workspace);
  return withFileLock(
    join(workspace, ".migrate.lock"),
    "Workspace migration",
    () => runLocked(inventoryPath, brokerState, clock, steps),
  );
}

// Throws unless the workspace is at the current data version. Commands that
// read or write workspace data call this so old data is never used silently.
export async function requireCurrent(inventoryPath: string): Promise<void> {
  const version = await detectVersion(inventoryPath);
  if (version === 0 || version === DATA_VERSION) return;
  if (version > DATA_VERSION)
    throw new HomectlError(
      5,
      `This workspace was written by a newer homectl (data version ${version}); update homectl`,
    );
  throw new HomectlError(
    5,
    "This workspace uses homectl 0.2 data. Run `home-ctl migrate` (preview with --dry-run) to upgrade it; a verified backup is taken first.",
  );
}
