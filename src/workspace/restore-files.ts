// What a restore may bring back (homelab #21 §6, W5). Only the scoped,
// persistent files a client backs up. Live sessions, pending approvals,
// ephemeral secrets and device or owner material are never restored, even if
// a snapshot somehow holds them.
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RestoredFile } from "../backup";
import { writeAtomic } from "../backup/store";
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

// Where a client writes restored files. A restore never overwrites: existing()
// names the restorable files already on the device, and write() refuses when
// any of them is present. A write that fails part way leaves nothing behind.
export interface RestoreTarget {
  existing(): Promise<string[]>;
  write(files: RestoredFile[]): Promise<void>;
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
    for (const name of RESTORABLE_FILES)
      if (await present(paths[name])) names.push(name);
    return names;
  };
  return {
    existing,
    async write(files) {
      for (const file of files)
        if (!isRestorable(file.path))
          throw new HomectlError(3, "Refusing to restore an unknown file");
      const taken = await existing();
      if (taken.length > 0)
        throw new HomectlError(
          3,
          `Refusing to overwrite ${taken.join(", ")} on this device`,
        );
      const written: string[] = [];
      try {
        for (const file of files) {
          const target = paths[file.path as RestorableFile];
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeAtomic(target, file.data);
          written.push(target);
        }
      } catch (error) {
        // Undo this attempt, so a retry starts from a device with no files.
        for (const target of written)
          await rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
