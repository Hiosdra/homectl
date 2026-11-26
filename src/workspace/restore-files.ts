// Restore only the scoped persistent files a client backs up. Live sessions,
// pending approvals, ephemeral values and device credentials are excluded.
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RestoredFile } from "../backup";
import { parseInventory } from "../inventory";
import { privateDirectory, protect } from "../platform";
import { HomectlError } from "../types";

export const RESTORABLE_FILES = [
  "inventory.yaml",
  "known_hosts",
  "policy.json",
] as const;
export type RestorableFile = (typeof RESTORABLE_FILES)[number];

export function isRestorable(path: string): path is RestorableFile {
  return (RESTORABLE_FILES as readonly string[]).includes(path);
}

export interface RestoreFileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export function restoreDigest(file: RestoredFile): RestoreFileDigest {
  return {
    path: file.path,
    bytes: file.data.length,
    sha256: createHash("sha256").update(file.data).digest("hex"),
  };
}

export interface RestoreTarget {
  existing(): Promise<string[]>;
  matches(expected: RestoreFileDigest[]): Promise<boolean>;
  write(files: RestoredFile[]): Promise<void>;
}

async function fileInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// A fresh daemon needs an inventory to start. Only the empty, unconfigured
// inventory that setup creates is eligible for replacement on a restore.
async function emptyInventory(path: string): Promise<Buffer | undefined> {
  const info = await fileInfo(path);
  if (!info?.isFile() || info.size > 4096) return undefined;
  const bytes = await readFile(path);
  try {
    const inventory = parseInventory(bytes.toString("utf8"));
    if (
      Object.keys(inventory).length === 2 &&
      Object.keys(inventory.machines).length === 0
    )
      return bytes;
  } catch {
    // An unreadable or malformed inventory requires the owner to move it aside.
  }
  return undefined;
}

async function replaceEmptyInventory(
  staged: string,
  path: string,
  expected: Buffer,
) {
  const original = `${path}.before-restore-${randomUUID()}`;
  await rename(path, original);
  try {
    if (!(await emptyInventory(original))?.equals(expected))
      throw new HomectlError(
        3,
        "The inventory changed while restore was starting",
      );
    // Never replace a file created by another writer after the rename.
    await link(staged, path);
  } catch (error) {
    try {
      await link(original, path);
    } catch {
      throw new HomectlError(
        5,
        `The inventory changed during restore. The previous file was preserved at ${original}`,
      );
    }
    await rm(original, { force: true });
    throw error;
  }
  await rm(original, { force: true }).catch(() => undefined);
}

export function fileRestoreTarget(
  inventoryPath: string,
  state: string,
): RestoreTarget {
  const paths: Record<RestorableFile, string> = {
    "inventory.yaml": inventoryPath,
    known_hosts: join(dirname(inventoryPath), "known_hosts"),
    "policy.json": join(state, "policy.json"),
  };
  const existing = async (): Promise<string[]> => {
    const names: string[] = [];
    for (const name of RESTORABLE_FILES) {
      if (await fileInfo(paths[name])) {
        if (name === "inventory.yaml" && (await emptyInventory(inventoryPath)))
          continue;
        names.push(name);
      }
    }
    return names;
  };
  return {
    existing,
    async matches(expected) {
      if (expected.length === 0) return false;
      const allowed = new Set(expected.map((file) => file.path));
      if ((await existing()).some((name) => !allowed.has(name))) return false;
      for (const file of expected) {
        if (!isRestorable(file.path)) return false;
        const path = paths[file.path];
        const info = await fileInfo(path);
        if (!info?.isFile() || info.size !== file.bytes) return false;
        const digest = restoreDigest({
          path: file.path,
          data: await readFile(path),
        });
        if (digest.sha256 !== file.sha256) return false;
      }
      return true;
    },
    async write(files) {
      const unique = new Map<RestorableFile, Uint8Array>();
      for (const file of files) {
        if (!isRestorable(file.path) || unique.has(file.path))
          throw new HomectlError(
            3,
            "Refusing to restore an unknown or duplicate file",
          );
        unique.set(file.path, file.data);
      }
      const initialInventory = unique.get("inventory.yaml");
      if (initialInventory)
        parseInventory(Buffer.from(initialInventory).toString("utf8"));
      const taken = await existing();
      if (taken.length > 0)
        throw new HomectlError(
          3,
          `Refusing to overwrite ${taken.join(", ")} on this device`,
        );
      const placeholder = await emptyInventory(inventoryPath);
      const installed: { target: string; staged: string }[] = [];
      const stagedPaths: string[] = [];
      try {
        // Inventory goes last. There are no remaining installs after it replaces
        // the placeholder, so a partial attempt never discards the placeholder.
        for (const name of [
          "known_hosts",
          "policy.json",
          "inventory.yaml",
        ] as const) {
          const data = unique.get(name);
          if (data === undefined) continue;
          const target = paths[name];
          await privateDirectory(dirname(target));
          const staged = `${target}.${randomUUID()}.restore`;
          await writeFile(staged, data, { mode: 0o600, flag: "wx" });
          stagedPaths.push(staged);
          await protect(staged);
          if (name === "inventory.yaml" && placeholder)
            await replaceEmptyInventory(staged, target, placeholder);
          else {
            await link(staged, target);
            installed.push({ target, staged });
          }
        }
      } catch (error) {
        for (const { target, staged } of installed) {
          const actual = await fileInfo(target).catch(() => undefined);
          const ours = await fileInfo(staged).catch(() => undefined);
          if (
            actual &&
            ours &&
            actual.dev === ours.dev &&
            actual.ino === ours.ino
          )
            await rm(target, { force: true }).catch(() => undefined);
        }
        throw error;
      } finally {
        for (const staged of stagedPaths)
          await rm(staged, { force: true }).catch(() => undefined);
      }
    },
  };
}
