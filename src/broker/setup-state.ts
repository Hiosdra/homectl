// Guided setup progress for the owner panel (0.3, audit B3). The broker keeps it in
// broker/setup.json, mode 0600, as booleans and timestamps only. A mark here never
// grants or implies trust: setup-detect.ts reads the real state (vault, machines,
// policy, requests) and a detected step wins over anything stored. A corrupt or
// missing file starts the checklist again, which is safe because nothing trusted is
// read from it.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { atomicReplace, protect } from "../platform";

// The steps the checklist counts. Welcome is a plain "seen" mark, not a step.
export const SETUP_STEPS = [
  "vault",
  "machine",
  "assistant",
  "first-request",
  "permissions",
  "devices",
  "notifications",
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const REQUIRED_STEPS: readonly SetupStepId[] = [
  "vault",
  "machine",
  "assistant",
  "first-request",
  "permissions",
];

export function isSetupStep(value: unknown): value is SetupStepId {
  return (SETUP_STEPS as readonly unknown[]).includes(value);
}

export type StoredStatus = "done" | "skipped";

export interface StoredStep {
  status: StoredStatus;
  at: number;
}

// How the owner wants to be guided: click through the steps here ("manual"), or let
// their AI agent do the setup work through the broker ("agent"). The choice only
// changes what the panel shows; it grants nothing and is never read as trust.
export const SETUP_PATHS = ["manual", "agent"] as const;
export type SetupPath = (typeof SETUP_PATHS)[number];

export function isSetupPath(value: unknown): value is SetupPath {
  return (SETUP_PATHS as readonly unknown[]).includes(value);
}

export interface SetupFile {
  version: 1;
  welcomedAt?: number;
  completedAt?: number;
  dismissedAt?: number;
  // Set when a data migration ran at startup (an upgrade from 0.2), and cleared
  // of its notice once the owner has read it.
  upgradedAt?: number;
  upgradeAckAt?: number;
  // The owner's chosen path. Absent until the owner picks one on Welcome.
  setupPath?: SetupPath;
  steps: Partial<Record<SetupStepId, StoredStep>>;
}

export function emptySetup(): SetupFile {
  return { version: 1, steps: {} };
}

// Whether a startup migration was an upgrade the owner should hear about. A fresh
// `home-ctl setup` also writes an inventory without a data marker, which the migration
// reads as a 0.2 workspace, so "migrated" alone is not enough. An upgrade from 0.2 is
// one that carried machines the owner has to reconnect assistants to.
export function isUpgradeNotice(
  migration: { status: string; from?: number },
  machinesBefore: number,
): boolean {
  return (
    migration.status === "migrated" &&
    migration.from === 2 &&
    machinesBefore > 0
  );
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

// Keeps only the known fields with their expected types. Anything else in the
// file is dropped, so nothing else is ever written back or served.
export function sanitizeSetup(value: unknown): SetupFile {
  const file = emptySetup();
  if (!value || typeof value !== "object" || Array.isArray(value)) return file;
  const source = value as Record<string, unknown>;
  const welcomedAt = timestamp(source.welcomedAt);
  const completedAt = timestamp(source.completedAt);
  const dismissedAt = timestamp(source.dismissedAt);
  const upgradedAt = timestamp(source.upgradedAt);
  const upgradeAckAt = timestamp(source.upgradeAckAt);
  if (welcomedAt !== undefined) file.welcomedAt = welcomedAt;
  if (completedAt !== undefined) file.completedAt = completedAt;
  if (dismissedAt !== undefined) file.dismissedAt = dismissedAt;
  if (upgradedAt !== undefined) file.upgradedAt = upgradedAt;
  if (upgradeAckAt !== undefined) file.upgradeAckAt = upgradeAckAt;
  if (isSetupPath(source.setupPath)) file.setupPath = source.setupPath;
  const steps = source.steps;
  if (steps && typeof steps === "object" && !Array.isArray(steps))
    for (const [id, entry] of Object.entries(steps)) {
      if (!isSetupStep(id) || !entry || typeof entry !== "object") continue;
      const status = (entry as { status?: unknown }).status;
      const at = timestamp((entry as { at?: unknown }).at);
      if ((status === "done" || status === "skipped") && at !== undefined)
        file.steps[id] = { status, at };
    }
  return file;
}

// Serialised read-modify-write of the setup file. The panel polls it while a
// step is open, so writes are rare and small.
export class SetupStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<SetupFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return emptySetup();
    }
    try {
      return sanitizeSetup(JSON.parse(text));
    } catch {
      return emptySetup();
    }
  }

  // `change` edits the file in place; the result is sanitized before it is saved.
  update(change: (file: SetupFile, at: number) => void): Promise<SetupFile> {
    const run = this.queue.then(async () => {
      const file = await this.load();
      change(file, this.now());
      const clean = sanitizeSetup(file);
      await this.save(clean);
      return clean;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async save(file: SetupFile): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
    await atomicReplace(temp, this.path);
    await protect(this.path);
  }
}
