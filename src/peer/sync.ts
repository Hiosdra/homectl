import { randomUUID } from "node:crypto";
import { HomectlError } from "../types";
import { digest } from "./crypto";
import type { PeerState, Version } from "./store";
export type Choice = "local" | "remote" | "both";
export type Conflict = { id: string; local: Version; remote: Version };
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}`;
}
export function hash(value: unknown) {
  return digest(stable(value));
}
export function clockCompare(a: Version["clock"], b: Version["clock"]) {
  let ahead = false;
  let behind = false;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[id] ?? 0) > (b[id] ?? 0)) ahead = true;
    if ((a[id] ?? 0) < (b[id] ?? 0)) behind = true;
  }
  return ahead && behind
    ? "conflict"
    : ahead
      ? "local"
      : behind
        ? "remote"
        : "equal";
}
export function joined(a: Version["clock"], b: Version["clock"]) {
  const c = { ...a };
  for (const [id, n] of Object.entries(b)) c[id] = Math.max(c[id] ?? 0, n);
  return c;
}
export function capture(
  state: PeerState,
  entries: Record<string, unknown>,
  prefixes: string[],
) {
  const ids = new Set([
    ...Object.keys(entries),
    ...Object.keys(state.observed).filter((id) =>
      prefixes.some((p) => id.startsWith(p)),
    ),
  ]);
  for (const id of ids) {
    const value = entries[id] ?? null;
    const fingerprint = hash(value);
    if (state.observed[id] === fingerprint) {
      if (state.records[id]) state.records[id].value = value;
      continue;
    }
    const prior = state.records[id];
    const clock = { ...prior?.clock };
    clock[state.id] = (clock[state.id] ?? 0) + 1;
    state.records[id] = { value, clock };
    state.observed[id] = fingerprint;
  }
}
export function validateRecords(input: unknown): Record<string, Version> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > 4096
  )
    throw new HomectlError(2, "Invalid peer records");
  for (const [id, record] of Object.entries(input)) {
    if (
      !/^(machine|provider|credential|hostkey):[A-Za-z0-9+/=_-]{1,128}$/.test(
        id,
      ) ||
      !record ||
      typeof record !== "object"
    )
      throw new HomectlError(2, "Invalid peer record");
    const v = record as Version;
    if (
      !v.clock ||
      typeof v.clock !== "object" ||
      Array.isArray(v.clock) ||
      !("value" in v) ||
      Object.keys(v.clock).length > 128 ||
      Object.entries(v.clock).some(
        ([p, n]) =>
          !/^[a-f0-9-]{36}$/.test(p) || !Number.isSafeInteger(n) || n < 1,
      )
    )
      throw new HomectlError(2, "Invalid peer revision");
  }
  return input as Record<string, Version>;
}
export function merge(
  local: Record<string, Version>,
  incoming: Record<string, Version>,
  device: string,
  choices: Record<string, Choice> = {},
) {
  const records = structuredClone(local);
  const conflicts: Conflict[] = [];
  const copies: string[] = [];
  for (const [id, remote] of Object.entries(validateRecords(incoming))) {
    const current = records[id];
    if (!current) {
      records[id] = structuredClone(remote);
      continue;
    }
    const order = clockCompare(current.clock, remote.clock);
    if (order === "remote") {
      records[id] = structuredClone(remote);
      continue;
    }
    if (order === "local") continue;
    if (hash(current.value) === hash(remote.value)) {
      current.clock = joined(current.clock, remote.clock);
      continue;
    }
    const choice = choices[id];
    if (!choice || !["local", "remote", "both"].includes(choice)) {
      conflicts.push({ id, local: current, remote });
      continue;
    }
    const clock = joined(current.clock, remote.clock);
    clock[device] = (clock[device] ?? 0) + 1;
    records[id] = {
      clock,
      value: structuredClone(
        choice === "remote" ? remote.value : current.value,
      ),
    };
    if (choice === "both" && remote.value !== null) {
      const prefix = id.split(":")[0];
      if (prefix === "hostkey")
        throw new HomectlError(
          2,
          "A conflicting host fingerprint cannot be trusted by keeping both; choose a verified version",
        );
      const newId = `${prefix}:copy-${randomUUID()}`;
      records[newId] = {
        clock: { [device]: 1 },
        value: structuredClone(remote.value),
      };
      copies.push(newId);
    }
  }
  return { records, conflicts, copies };
}
