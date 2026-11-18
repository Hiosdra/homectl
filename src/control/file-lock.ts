import { randomUUID } from "node:crypto";
import { readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { privateDirectory } from "../platform";
import { HomectlError } from "../types";

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 10_000;
const directorySetups = new Map<string, Promise<void>>();

type FileLockOptions = {
  staleMs?: number;
  heartbeatMs?: number;
  waitMs?: number;
};

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
  options: FileLockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs =
    options.heartbeatMs ?? Math.min(LOCK_HEARTBEAT_MS, Math.floor(staleMs / 3));
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  const ownership = `${process.pid}\n${randomUUID()}\n`;
  for (;;) {
    try {
      await writeFile(lockPath, ownership, {
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new HomectlError(5, `${label} cannot be locked`);
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs)
          await unlink(lockPath).catch(() => undefined);
      } catch {}
      if (Date.now() > deadline)
        throw new HomectlError(5, `${label} is busy; retry`);
      await Bun.sleep(25);
    }
  }
  let heartbeatRunning = false;
  const heartbeat = setInterval(
    () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void (async () => {
        try {
          if ((await readFile(lockPath, "utf8")) !== ownership) return;
          const now = new Date();
          await utimes(lockPath, now, now);
        } catch {
          return;
        } finally {
          heartbeatRunning = false;
        }
      })();
    },
    Math.max(1, heartbeatMs),
  );
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      if ((await readFile(lockPath, "utf8")) === ownership)
        await unlink(lockPath);
    } catch {}
  }
}
