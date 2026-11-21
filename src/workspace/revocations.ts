// Revocations reapplied to a restored state (homelab #21 §6: reapply current
// revocations). A client reports the host keys its known_hosts lists as
// @revoked and the ids of the policy rules it holds. A restore brings back the
// snapshot's files, so before delivery:
//   - known_hosts: pinned entries for a revoked key are dropped, and an
//     @revoked marker is added for each revoked key;
//   - policy.json: rules the snapshot has but the report does not are dropped,
//     but only when the report is at or after the snapshot. An older report
//     cannot tell a rule removed later from one added after it.
// Revocations made after the client's last report are not known. The notes say
// so, and the restored files are never rewritten beyond these rules.
import { readFile } from "node:fs/promises";
import type { RestoredFile } from "../backup";
import type { HostKeyRef, Revocations } from "./state";

const KEY_TYPE = /^[A-Za-z0-9@.+-]{1,64}$/;
const BLOB = /^[A-Za-z0-9+/]{1,16384}={0,2}$/;
const MAX_RULES = 2048;

// What a client reports, before the time is added.
export interface RevocationSet {
  hostKeys: HostKeyRef[];
  policyRules?: string[];
}

async function textOf(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// The client's current revocations. A missing known_hosts has no revoked keys;
// a missing or unreadable policy reports no rule ids at all.
export async function readRevocations(
  knownHostsPath: string,
  policyPath: string,
): Promise<RevocationSet> {
  const hostKeys = revokedKeys((await textOf(knownHostsPath)) ?? "");
  const policyRules = policyRuleIds(await textOf(policyPath));
  return policyRules === undefined ? { hostKeys } : { hostKeys, policyRules };
}

// Lines "@revoked <hosts> <type> <blob>" in known_hosts syntax.
export function revokedKeys(text: string): HostKeyRef[] {
  const keys = new Map<string, HostKeyRef>();
  for (const line of text.split("\n")) {
    const [marker, , type, blob] = line.trim().split(/\s+/);
    if (marker !== "@revoked" || !type || !blob) continue;
    if (!KEY_TYPE.test(type) || !BLOB.test(blob)) continue;
    keys.set(blob, { type, blob });
  }
  return [...keys.values()];
}

// The ids of the rules in a policy document, or undefined when it is not one.
export function policyRuleIds(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  const rules = parsePolicy(text)?.rules;
  if (!Array.isArray(rules)) return undefined;
  const ids: string[] = [];
  for (const rule of rules.slice(0, MAX_RULES))
    if (typeof (rule as { id?: unknown })?.id === "string")
      ids.push((rule as { id: string }).id);
  return ids;
}

function parsePolicy(text: string): { rules?: unknown } | undefined {
  try {
    const doc = JSON.parse(text) as unknown;
    return doc !== null && typeof doc === "object"
      ? (doc as { rules?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

export interface AppliedRevocations {
  files: RestoredFile[];
  notes: string[];
}

// Applies the reported revocations to the restorable files of a snapshot taken
// at `snapshotAt` (the client's clock, as the snapshot header records it).
export function applyRevocations(
  files: RestoredFile[],
  revoked: Revocations | undefined,
  snapshotAt: number,
): AppliedRevocations {
  if (!revoked)
    return {
      files,
      notes: [
        "This client reported no revocations, so none were reapplied to the restore.",
      ],
    };
  const notes: string[] = [];
  const out = files.map((file) => {
    if (file.path === "known_hosts") {
      const result = dropRevokedKeys(file.data, revoked.hostKeys);
      if (result.changed)
        notes.push(
          `known_hosts: ${result.dropped} revoked key(s) removed, ${result.marked} revocation marker(s) added.`,
        );
      return result.changed ? { path: file.path, data: result.data } : file;
    }
    if (file.path === "policy.json") {
      if (revoked.policyRules === undefined) {
        notes.push(
          "policy.json: the client reported no policy, so its rules were not filtered.",
        );
        return file;
      }
      if (revoked.at < snapshotAt) {
        notes.push(
          "policy.json: the last report predates the snapshot, so its rules were not filtered. Check the restored policy.",
        );
        return file;
      }
      const result = dropRevokedRules(file.data, revoked.policyRules);
      if (result.unreadable)
        notes.push(
          "policy.json could not be read; its rules were not filtered.",
        );
      else if (result.dropped > 0)
        notes.push(
          `policy.json: ${result.dropped} rule(s) revoked since the snapshot were removed.`,
        );
      return result.changed ? { path: file.path, data: result.data } : file;
    }
    return file;
  });
  notes.push(
    "Revocations made after the client's last report are not known and were not reapplied.",
  );
  return { files: out, notes };
}

function dropRevokedKeys(data: Uint8Array, revoked: HostKeyRef[]) {
  const unchanged = { changed: false, data, dropped: 0, marked: 0 };
  if (revoked.length === 0) return unchanged;
  const revokedBlobs = new Set(revoked.map((key) => key.blob));
  const lines = Buffer.from(data).toString("utf8").split("\n");
  const marked = new Set<string>();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "@revoked" && fields[3]) marked.add(fields[3]);
  }
  let dropped = 0;
  const kept = lines.filter((line) => {
    const fields = line.trim().split(/\s+/);
    if (!fields[2] || fields[0]?.startsWith("@")) return true;
    if (!revokedBlobs.has(fields[2])) return true;
    dropped += 1;
    return false;
  });
  const added = revoked
    .filter((key) => !marked.has(key.blob))
    .map((key) => `@revoked * ${key.type} ${key.blob}`);
  if (dropped === 0 && added.length === 0) return unchanged;
  const body = kept.join("\n").replace(/\n+$/, "");
  const text = [body, ...added].filter((part) => part.length > 0).join("\n");
  return {
    changed: true,
    data: new Uint8Array(Buffer.from(`${text}\n`, "utf8")),
    dropped,
    marked: added.length,
  };
}

function dropRevokedRules(data: Uint8Array, current: string[]) {
  const unchanged = { changed: false, data, dropped: 0, unreadable: false };
  const doc = parsePolicy(Buffer.from(data).toString("utf8"));
  if (!doc || !Array.isArray(doc.rules))
    return { ...unchanged, unreadable: true };
  const held = new Set(current);
  const rules = doc.rules as { id?: unknown }[];
  // A rule without an id cannot be matched against the report, so it is kept.
  const kept = rules.filter(
    (rule) => typeof rule?.id !== "string" || held.has(rule.id),
  );
  const dropped = rules.length - kept.length;
  if (dropped === 0) return unchanged;
  const text = `${JSON.stringify({ ...doc, rules: kept }, null, 2)}\n`;
  return {
    changed: true,
    data: new Uint8Array(Buffer.from(text, "utf8")),
    dropped,
    unreadable: false,
  };
}
