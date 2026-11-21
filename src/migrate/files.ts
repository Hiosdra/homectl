// File helpers for the migration: digests, a snapshot of the workspace (to
// detect writes a step did not declare), and a backup of touched files that
// can be restored and verified byte for byte.
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicReplace, privateDirectory } from "../platform";
import { HomectlError } from "../types";

export const BACKUP_DIRECTORY = "backups";
export const PROGRESS_FILE = "migration-progress.json";

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// undefined when the file does not exist.
export async function digestOf(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// True for any entry (file or directory) that exists; does not follow links.
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

// Every regular file in the workspace, keyed by workspace-relative path. Held in
// memory only for the length of a run, so a write a step did not declare can
// be undone exactly. Skips what the migration never reads or writes: its own
// backups and progress, lock files, runtime session directories and sockets.
export async function captureWorkspace(
  root: string,
): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  async function walk(dir: string, depth: number) {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (depth === 0 && (name === BACKUP_DIRECTORY || name === PROGRESS_FILE))
        continue;
      if (name.endsWith(".lock") || name.endsWith(".tmp")) continue;
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.isSocket() || info.isFIFO()) continue;
      if (info.isDirectory()) {
        if (name.endsWith(".session")) continue;
        await walk(path, depth + 1);
      } else if (info.isFile()) {
        result[toPosix(relative(root, path))] = await readFile(path);
      }
    }
  }
  await walk(root, 0);
  return result;
}

export interface BackupEntry {
  path: string;
  existed: boolean;
  sha256?: string;
  // Name of the copy inside the backup's files/ directory.
  file?: string;
}

export interface BackupManifest {
  from: number;
  to: number;
  created: string;
  entries: BackupEntry[];
}

export async function writeFileAtomic(path: string, bytes: Buffer | string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
  await atomicReplace(temp, path);
}

// Copies every listed path that exists into a new private backup directory,
// then writes manifest.json. Paths that do not exist are recorded so a
// rollback removes whatever the migration creates.
export async function backupPaths(
  directory: string,
  paths: string[],
  meta: { from: number; to: number; created: string },
): Promise<BackupManifest> {
  await privateDirectory(join(directory, "files"));
  const entries: BackupEntry[] = [];
  for (const [index, path] of paths.entries()) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries.push({ path, existed: false });
      continue;
    }
    const file = `${index}`;
    await writeFileAtomic(join(directory, "files", file), bytes);
    entries.push({ path, existed: true, sha256: sha256(bytes), file });
  }
  const manifest: BackupManifest = { ...meta, entries };
  await writeFileAtomic(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function readManifest(directory: string): Promise<BackupManifest> {
  try {
    return JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    ) as BackupManifest;
  } catch {
    throw new HomectlError(
      5,
      "Migration backup is missing or unreadable; restore the workspace from your own backup before continuing",
    );
  }
}

// Puts every backed-up file back exactly, removes files the migration created,
// and checks the result. Throws when the workspace does not match the backup.
export async function restoreBackup(directory: string): Promise<void> {
  const manifest = await readManifest(directory);
  for (const entry of manifest.entries) {
    if (entry.existed) {
      const bytes = await readFile(join(directory, "files", entry.file ?? ""));
      if (sha256(bytes) !== entry.sha256)
        throw new HomectlError(5, "Migration backup failed its own check");
      await writeFileAtomic(entry.path, bytes);
    } else {
      await rm(entry.path, { force: true });
    }
  }
  for (const entry of manifest.entries) {
    const now = await digestOf(entry.path);
    if (entry.existed ? now !== entry.sha256 : now !== undefined)
      throw new HomectlError(
        5,
        "Rollback did not restore every file; keep the backup and restore it by hand before using homectl",
      );
  }
}
