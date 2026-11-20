// Browser side of backup requests and restores for linked clients (homelab #21
// §6). A request only asks a client to back up at its next sync. A preview and a
// restore decrypt backups, so both need the owner password and a reason. A
// restore revokes the client and issues a one-time code for a fresh device. Every
// response is checked against its documented shape before the page uses it.
import { OwnerApiError, ownerCall } from "./api";

export interface WorkspaceRestoreFile {
  path: string;
  size: number;
  // False for files the restore never writes (they are listed, not restored).
  restorable: boolean;
}

export interface WorkspaceRestorePreview {
  source: string;
  seq: number;
  createdAt: number;
  bytes: number;
  verified: boolean;
  problems: string[];
  // Every snapshot sequence the server holds for this client.
  seqs: number[];
  files: WorkspaceRestoreFile[];
}

export interface WorkspaceRestoreIssued {
  code: string;
  expiresAt: string;
  restore: { source: string; seq: number; files: number; bytes: number };
  server: { id: string; name: string };
}

const MAX_FILES = 500;

// Asks the client to take a backup at its next sync. No password: it changes
// nothing that is not already allowed to change.
export function requestWorkspaceBackup(
  client: string,
): Promise<{ client: string; requested: boolean }> {
  return ownerCall<{ client: string; requested: boolean }>(
    "/v1/owner/workspace/backup-request",
    { client },
  );
}

export const RESTORE_SEQ_PROBLEM =
  "Version must be a whole number, 1 or more, from the versions listed.";

// The version the owner typed. Blank means the latest snapshot, which the server
// picks. Anything else must be a positive whole number; the server then checks
// that it holds that version and says so if it does not.
export function parseRestoreSeq(
  text: string,
): { ok: true; seq: number | undefined } | { ok: false; problem: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, seq: undefined };
  if (!/^\d+$/.test(trimmed))
    return { ok: false, problem: RESTORE_SEQ_PROBLEM };
  const seq = Number(trimmed);
  if (!Number.isSafeInteger(seq) || seq < 1)
    return { ok: false, problem: RESTORE_SEQ_PROBLEM };
  return { ok: true, seq };
}

// Lists what a snapshot holds. Decrypting it is backup decryption, so it needs
// the owner password and a reason, and the server records the reason. Without
// `seq` the server previews its latest snapshot.
export async function previewWorkspaceRestore(input: {
  client: string;
  seq?: number;
  reason: string;
  password: string;
}): Promise<WorkspaceRestorePreview> {
  const raw = await ownerCall<unknown>(
    "/v1/owner/workspace/restore-preview",
    input,
  );
  const preview = toRestorePreview(raw);
  if (preview === undefined) throw unreadable("snapshot preview");
  return preview;
}

// Revokes the client and issues the one-time code. Nothing is restored until a
// fresh device joins with the code.
export async function restoreWorkspaceClient(input: {
  client: string;
  seq: number;
  reason: string;
  password: string;
}): Promise<WorkspaceRestoreIssued> {
  const raw = await ownerCall<unknown>("/v1/owner/workspace/restore", input);
  const issued = toRestoreIssued(raw);
  // The server may already have revoked the client: say so, not just "unreadable".
  if (issued === undefined)
    throw new OwnerApiError(
      502,
      5,
      "The server answered, but this panel cannot read the restore code. The client may already be revoked. Check the server's clients before you do anything else.",
    );
  return issued;
}

// Accepts only the documented shape. Files beyond MAX_FILES are refused rather
// than rendered.
export function toRestorePreview(
  value: unknown,
): WorkspaceRestorePreview | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const files = Array.isArray(raw.files) ? raw.files : undefined;
  const seqs = Array.isArray(raw.seqs) ? raw.seqs : undefined;
  const problems = Array.isArray(raw.problems) ? raw.problems : undefined;
  if (
    typeof raw.source !== "string" ||
    !isCount(raw.seq) ||
    !isCount(raw.createdAt) ||
    !isCount(raw.bytes) ||
    typeof raw.verified !== "boolean" ||
    problems === undefined ||
    !problems.every((item) => typeof item === "string") ||
    seqs === undefined ||
    !seqs.every(isCount) ||
    files === undefined ||
    files.length > MAX_FILES
  )
    return undefined;
  const rows: WorkspaceRestoreFile[] = [];
  for (const item of files) {
    const file = record(item);
    if (
      file === undefined ||
      typeof file.path !== "string" ||
      !isCount(file.size) ||
      typeof file.restorable !== "boolean"
    )
      return undefined;
    rows.push({
      path: file.path,
      size: file.size,
      restorable: file.restorable,
    });
  }
  return {
    source: raw.source,
    seq: raw.seq as number,
    createdAt: raw.createdAt as number,
    bytes: raw.bytes as number,
    verified: raw.verified,
    problems: problems as string[],
    seqs: seqs as number[],
    files: rows,
  };
}

export function toRestoreIssued(
  value: unknown,
): WorkspaceRestoreIssued | undefined {
  const raw = record(value);
  const restore = record(raw?.restore);
  const server = record(raw?.server);
  if (
    raw === undefined ||
    restore === undefined ||
    server === undefined ||
    typeof raw.code !== "string" ||
    typeof raw.expiresAt !== "string" ||
    Number.isNaN(Date.parse(raw.expiresAt)) ||
    typeof restore.source !== "string" ||
    !isCount(restore.seq) ||
    !isCount(restore.files) ||
    !isCount(restore.bytes) ||
    typeof server.id !== "string" ||
    typeof server.name !== "string"
  )
    return undefined;
  return {
    code: raw.code,
    expiresAt: raw.expiresAt,
    restore: {
      source: restore.source,
      seq: restore.seq as number,
      files: restore.files as number,
      bytes: restore.bytes as number,
    },
    server: { id: server.id, name: server.name },
  };
}

// Plain sizes for the file list: bytes, then KB or MB with one decimal.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// The server answered, but not in a shape this panel can show. Nothing is
// assumed about what happened on the server.
function unreadable(what: string): OwnerApiError {
  return new OwnerApiError(
    502,
    5,
    `The server sent a ${what} this panel cannot read. Check the server before you try again.`,
  );
}
