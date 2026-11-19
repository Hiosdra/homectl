// Versioned, transactional data migration (0.3.0, homelab #21 §3).
//
// A workspace is the directory holding the inventory. Its data version is kept
// in `homectl-data.json`. A workspace without the marker but with legacy files
// is version 2 (homectl 0.2.x). Migration:
//   1. takes the workspace migration lock,
//   2. copies every known workspace entry into a private, hash-verified backup,
//   3. runs each pending step once (progress is recorded, so a re-run resumes),
//   4. verifies every step, then writes the marker atomically.
// Any failure restores the backup and leaves the workspace at its old version.
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { withFileLock } from "../control/file-lock";
import { atomicReplace, privateDirectory } from "../platform";
import { HomectlError } from "../types";
import { STEPS } from "./steps";

export const DATA_VERSION = 3;
export const MARKER_FILE = "homectl-data.json";
const PROGRESS_FILE = "migration-progress.json";
const BACKUP_DIRECTORY = "backups";

// Workspace entries that belong to homectl. Anything else in the directory is
// left alone and is never copied. Runtime-only state (session sockets, locks)
// is excluded on purpose: migration never resurrects sessions.
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

export interface MigrationContext {
  workspace: string;
  inventoryPath: string;
  now: number;
  // Free-form notes a step reports to the owner (no secret values).
  note(message: string): void;
}

export interface MigrationStep {
  id: string;
  from: number;
  to: number;
  description: string;
  run(context: MigrationContext): Promise<void>;
  // Must throw when the step's result is not in place.
  verify(context: MigrationContext): Promise<void>;
}

export interface MarkerHistory {
  from: number;
  to: number;
  at: string;
  backup: string;
  steps: string[];
}

export interface Marker {
  data_version: number;
  history: MarkerHistory[];
}

export type MigrationResult =
  | { status: "current"; version: number }
  | { status: "initialized"; version: number }
  | {
      status: "planned";
      from: number;
      to: number;
      steps: { id: string; description: string }[];
    }
  | {
      status: "migrated";
      from: number;
      to: number;
      backup: string;
      steps: string[];
      notes: string[];
    };

interface Progress {
  from: number;
  to: number;
  backup: string;
  completed: string[];
}

export function workspaceOf(inventoryPath: string): string {
  return dirname(resolve(inventoryPath));
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
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

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await atomicReplace(temp, path);
}

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

async function hashTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.isSocket() || info.isFIFO()) return;
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name));
      return;
    }
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    result[relative(root, path).split("\\").join("/")] = digest;
  }
  if (await present(root)) await walk(root);
  return result;
}

async function backupWorkspace(
  inventoryPath: string,
  from: number,
  now: number,
): Promise<string> {
  const workspace = workspaceOf(inventoryPath);
  const root = join(workspace, BACKUP_DIRECTORY);
  await privateDirectory(root);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const target = join(root, `migration-v${from}-${stamp}`);
  await mkdir(target, { mode: 0o700 });
  const manifest: Record<string, string> = {};
  for (const entry of entriesFor(inventoryPath)) {
    const source = join(workspace, entry);
    if (!(await present(source))) continue;
    await cp(source, join(target, entry), {
      recursive: true,
      // Never copy sockets or session state into a backup.
      filter: async (path) => {
        const info = await lstat(path);
        return !info.isSocket() && !info.isFIFO() && !path.endsWith(".lock");
      },
    });
    for (const [file, digest] of Object.entries(
      await hashTree(join(target, entry)),
    ))
      manifest[file === "" ? entry : `${entry}/${file}`] = digest;
  }
  // Verify the copy against the source before any step runs.
  for (const [file, digest] of Object.entries(manifest)) {
    const copy = createHash("sha256")
      .update(await readFile(join(workspace, file)))
      .digest("hex");
    if (copy !== digest)
      throw new HomectlError(
        5,
        `Backup verification failed for ${file}; nothing was changed`,
      );
  }
  await writeJson(join(target, "manifest.json"), { from, files: manifest });
  return target;
}

async function restoreBackup(
  inventoryPath: string,
  backup: string,
): Promise<void> {
  const workspace = workspaceOf(inventoryPath);
  for (const entry of entriesFor(inventoryPath)) {
    const live = join(workspace, entry);
    const saved = join(backup, entry);
    if (await present(saved)) {
      await rm(live, { recursive: true, force: true });
      await cp(saved, live, { recursive: true });
    } else if (entry === MARKER_FILE) {
      await rm(live, { force: true });
    }
  }
}

export function pendingSteps(
  from: number,
  steps: readonly MigrationStep[] = STEPS,
): MigrationStep[] {
  const chain: MigrationStep[] = [];
  let version = from;
  for (const step of steps) {
    if (step.from < version) continue;
    if (step.from !== version && step.to !== version)
      throw new HomectlError(5, `Migration chain has a gap at v${version}`);
    chain.push(step);
    version = step.to;
  }
  if (from > 0 && from < DATA_VERSION && version !== DATA_VERSION)
    throw new HomectlError(
      5,
      `No migration path from data version ${from} to ${DATA_VERSION}`,
    );
  return chain;
}

export async function migrate(
  inventoryPath: string,
  options: {
    dryRun?: boolean;
    clock?: () => number;
    steps?: readonly MigrationStep[];
  } = {},
): Promise<MigrationResult> {
  const workspace = workspaceOf(inventoryPath);
  const clock = options.clock ?? Date.now;
  const steps = options.steps ?? STEPS;
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
    return {
      status: "planned",
      from,
      to: DATA_VERSION,
      steps: pendingSteps(from, steps).map(({ id, description }) => ({
        id,
        description,
      })),
    };
  }
  await privateDirectory(workspace);
  return withFileLock(
    join(workspace, ".migrate.lock"),
    "Workspace migration",
    async () => {
      const now = clock();
      // Re-check under the lock: another process may have finished first.
      const version = await detectVersion(inventoryPath);
      if (version === DATA_VERSION) return { status: "current", version };
      const markerPath = join(workspace, MARKER_FILE);
      if (version === 0) {
        await writeJson(markerPath, {
          data_version: DATA_VERSION,
          history: [],
        });
        return { status: "initialized", version: DATA_VERSION };
      }
      const chain = pendingSteps(version, steps);
      const progressPath = join(workspace, PROGRESS_FILE);
      let progress = await readJson<Progress>(progressPath);
      if (
        progress &&
        (progress.from !== version ||
          progress.to !== DATA_VERSION ||
          !(await present(progress.backup)))
      )
        throw new HomectlError(
          5,
          `${PROGRESS_FILE} does not match this workspace; restore from backups/ or remove it after checking`,
        );
      if (!progress) {
        const backup = await backupWorkspace(inventoryPath, version, now);
        progress = { from: version, to: DATA_VERSION, backup, completed: [] };
        await writeJson(progressPath, progress);
      }
      const notes: string[] = [];
      const context: MigrationContext = {
        workspace,
        inventoryPath: resolve(inventoryPath),
        now,
        note: (message) => notes.push(message),
      };
      try {
        for (const step of chain) {
          if (progress.completed.includes(step.id)) continue;
          await step.run(context);
          progress.completed.push(step.id);
          await writeJson(progressPath, progress);
        }
        for (const step of chain) await step.verify(context);
        const previous = await readJson<Marker>(markerPath);
        await writeJson(markerPath, {
          data_version: DATA_VERSION,
          history: [
            ...(previous?.history ?? []),
            {
              from: version,
              to: DATA_VERSION,
              at: new Date(now).toISOString(),
              backup: relative(workspace, progress.backup)
                .split("\\")
                .join("/"),
              steps: chain.map((step) => step.id),
            },
          ],
        } satisfies Marker);
        await rm(progressPath, { force: true });
        return {
          status: "migrated",
          from: version,
          to: DATA_VERSION,
          backup: progress.backup,
          steps: chain.map((step) => step.id),
          notes,
        };
      } catch (error) {
        await restoreBackup(inventoryPath, progress.backup);
        await rm(progressPath, { force: true });
        throw new HomectlError(
          5,
          `Migration to data version ${DATA_VERSION} failed and was rolled back; the workspace is unchanged (backup: ${progress.backup})`,
          {
            step: chain.find((step) => !progress?.completed.includes(step.id))
              ?.id,
            reason: error instanceof HomectlError ? error.message : undefined,
          },
        );
      }
    },
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
