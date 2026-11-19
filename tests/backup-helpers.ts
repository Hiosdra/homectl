import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotInput } from "../src/backup";
import { BackupStore, LocalBackupServer } from "../src/backup";

export const CLIENT = "laptop-a";
export const SMALL_CHUNK = 16;

export interface Fixture {
  root: string;
  store: BackupStore;
  server: LocalBackupServer;
  cleanup(): Promise<void>;
}

export async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "homectl-backup-test-"));
  const store = new BackupStore(join(root, "store"));
  return {
    root,
    store,
    server: new LocalBackupServer(store),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// Deterministic, content-distinct bytes: different seeds give different chunks.
export function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1)
    out[index] = (seed * 31 + index * 17 + (index >> 3) * 7) & 0xff;
  return out;
}

// Returns the HomectlError code thrown by fn (sync or async), or undefined.
export async function codeOf(fn: () => unknown): Promise<number | undefined> {
  try {
    await fn();
  } catch (error) {
    return (error as { code?: number }).code;
  }
  return undefined;
}

export const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function fileOf(
  path: string,
  length: number,
  seed: number,
): SnapshotInput {
  return { path, data: bytesOf(length, seed) };
}
