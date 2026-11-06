// Startup recovery for the containerized peer (docs/homectl-2.0/container-peer.md).
// Checks run before any listener opens. Integrity doubts stop the start (fail
// closed); nothing is repaired automatically. Messages never carry entry
// contents or secret material.
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { controlStateDirectory } from "../control/engine";
import { AuditJournal } from "../control/journal";
import { privateDirectory } from "../platform";
import { HomectlError } from "../types";

export const RUN_FILE = "run.json";
export const LAUNCH_FILE = "panel.json";

export type StartupStatus = {
  status: "clean" | "recovered";
  warnings: string[];
};

type RunRecord =
  | { state: "running"; pid: number; startedAt: string }
  | { state: "stopped" };

export function serveDirectoryOf(inventoryPath: string): string {
  return join(dirname(resolve(inventoryPath)), "serve");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// True when the process exists. EPERM means it exists under another user.
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function listNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new HomectlError(
      5,
      "State directory cannot be read; refusing to start",
    );
  }
}

async function readRunRecord(serveDir: string): Promise<RunRecord | undefined> {
  let text: string;
  try {
    text = await readFile(join(serveDir, RUN_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new HomectlError(5, "Run state cannot be read; refusing to start");
  }
  let data: Record<string, unknown> | null;
  try {
    data = JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    data = null;
  }
  if (data?.state === "stopped") return { state: "stopped" };
  if (
    data?.state === "running" &&
    Number.isInteger(data.pid) &&
    typeof data.startedAt === "string"
  )
    return {
      state: "running",
      pid: data.pid as number,
      startedAt: data.startedAt,
    };
  throw new HomectlError(
    5,
    "Run state is unreadable; refusing to start. Restore the volume from backup.",
  );
}

// Verifies the audit journal against its anchor. A lagging anchor is accepted
// (a crash between append and anchor write, which the journal already allows);
// truncation, divergence or an unparseable tail is refused.
async function verifyAudit(controlDir: string): Promise<void> {
  const journal = new AuditJournal(
    join(controlDir, "audit.jsonl"),
    join(controlDir, "audit.anchor"),
  );
  let error: string | undefined;
  try {
    const check = await journal.verify();
    if (check.ok) return;
    error = check.error ?? "unknown";
  } catch {
    error = "journal cannot be read";
  }
  throw new HomectlError(
    5,
    `Audit journal failed startup verification (${error}); nothing was changed. Restore the control-plane directory from backup or run homectl control audit verify.`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// Runs every startup check. Returns warnings for a degraded start; throws
// HomectlError (exit 3 for a live duplicate, 5 for an integrity doubt).
export async function recoverStartup(options: {
  inventoryPath: string;
  isAlive?: (pid: number) => boolean;
}): Promise<StartupStatus> {
  const isAlive = options.isAlive ?? pidAlive;
  const serveDir = serveDirectoryOf(options.inventoryPath);
  const controlDir = controlStateDirectory(options.inventoryPath);
  const warnings: string[] = [];

  // A run marker that still says "running" means the previous process did not
  // reach its shutdown path. A live pid other than ours is a second instance.
  const run = await readRunRecord(serveDir);
  if (run?.state === "running") {
    if (run.pid !== process.pid && isAlive(run.pid))
      throw new HomectlError(
        3,
        "Another homectl process is using this volume; stop it before starting this container",
      );
    warnings.push(
      `previous run did not stop cleanly (started ${run.startedAt}); starting without repair`,
    );
  }

  // A control-plane lock left by an interrupted writer. A live owner refuses.
  const lockText = await readFile(join(controlDir, ".lock"), "utf8").catch(
    () => "",
  );
  const lockPid = Number.parseInt(lockText.trim(), 10);
  if (Number.isInteger(lockPid) && lockPid > 0) {
    if (lockPid !== process.pid && isAlive(lockPid))
      throw new HomectlError(
        3,
        "Control-plane state is locked by another process; stop it before starting this container",
      );
    warnings.push(
      "control-plane lock left by an interrupted run; the next writer removes it after the stale timeout",
    );
  }

  if ((await listNames(controlDir)).some((name) => name.startsWith("audit.")))
    await verifyAudit(controlDir);

  // Atomic writes leave a *.tmp file only when interrupted before the rename.
  // The committed file is still the last consistent version, so keep both.
  for (const directory of [serveDir, controlDir])
    for (const name of await listNames(directory))
      if (name.endsWith(".tmp"))
        warnings.push(
          `half-written file left by an interrupted write: ${name} (kept; the committed file is the last consistent version)`,
        );

  // The launch token belongs to a server that is gone.
  const launch = join(serveDir, LAUNCH_FILE);
  if (await exists(launch)) {
    await rm(launch, { force: true });
    warnings.push("removed a panel launch token from an earlier run");
  }

  return { status: warnings.length > 0 ? "recovered" : "clean", warnings };
}

async function writeRunRecord(
  inventoryPath: string,
  record: RunRecord,
  version: string,
): Promise<void> {
  const serveDir = serveDirectoryOf(inventoryPath);
  await privateDirectory(serveDir);
  const path = join(serveDir, RUN_FILE);
  const temp = `${path}.${randomUUID()}.tmp`;
  const body = { ...record, version, at: new Date().toISOString() };
  await writeFile(temp, `${JSON.stringify(body)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}

// Written once the listeners are up: "running" means this process serves.
export async function markRunning(
  inventoryPath: string,
  version: string,
): Promise<void> {
  await writeRunRecord(
    inventoryPath,
    { state: "running", pid: process.pid, startedAt: new Date().toISOString() },
    version,
  );
}

// Written after the listeners close: "stopped" is a clean shutdown.
export async function markStopped(
  inventoryPath: string,
  version: string,
): Promise<void> {
  await writeRunRecord(inventoryPath, { state: "stopped" }, version);
}
