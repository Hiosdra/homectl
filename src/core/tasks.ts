// Task records (homelab #21 §7): origin-owned units of work with a bounded
// lifetime and a bounded number of open tasks per client. Pure functions over
// the broker state; the engine persists them.
import { randomBytes } from "node:crypto";
import { HomectlError } from "../types";
import type { TaskRecord } from "./contracts";

export const MAX_TASK_TTL_MS = 24 * 60 * 60_000;
export const MAX_OPEN_TASKS = 32;
const DEFAULT_TTL_MS = 4 * 60 * 60_000;

export function openTask(
  state: { tasks: Record<string, TaskRecord> },
  client: string,
  raw: { title?: unknown; ttlMs?: unknown },
  now: number,
): TaskRecord {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title || title.length > 200)
    throw new HomectlError(2, "Task title must be 1-200 characters");
  const ttl =
    typeof raw.ttlMs === "number" && Number.isSafeInteger(raw.ttlMs)
      ? Math.min(Math.max(raw.ttlMs, 60_000), MAX_TASK_TTL_MS)
      : DEFAULT_TTL_MS;
  const open = Object.values(state.tasks).filter(
    (t) => t.client === client && t.state === "open",
  );
  if (open.length >= MAX_OPEN_TASKS)
    throw new HomectlError(3, "Too many open tasks; close some first");
  const task: TaskRecord = {
    id: `tsk_${randomBytes(12).toString("base64url")}`,
    client,
    title,
    createdAt: now,
    expiresAt: now + ttl,
    state: "open",
    used: { operations: 0, riskPoints: 0 },
    operations: [],
  };
  state.tasks[task.id] = task;
  return task;
}

export function closeTask(
  state: { tasks: Record<string, TaskRecord> },
  client: string,
  id: string,
): TaskRecord {
  const task = state.tasks[id];
  if (!task || task.client !== client)
    throw new HomectlError(3, "Unknown task");
  task.state = "closed";
  return task;
}
