import { stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { privateDirectory } from "../platform";
import { HomectlError } from "../types";

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const directorySetups = new Map<string, Promise<void>>();

export async function ensurePrivateDirectoryOnce(path: string): Promise<void> {
  const directory = resolve(path);
  let setup = directorySetups.get(directory);
  if (!setup) {
    setup = privateDirectory(directory);
    directorySetups.set(directory, setup);
  }
  try {
    await setup;
  } catch (error) {
    if (directorySetups.get(directory) === setup)
      directorySetups.delete(directory);
    throw error;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new HomectlError(5, `${label} cannot be locked`);
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS)
          await unlink(lockPath).catch(() => undefined);
      } catch {}
      if (Date.now() > deadline)
        throw new HomectlError(5, `${label} is busy; retry`);
      await Bun.sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}
