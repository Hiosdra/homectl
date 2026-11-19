// Backup scope rules (homelab #21 §6): only intentionally scoped persistent
// state is backed up. Live sessions, pending approvals, ephemeral secrets and
// lock/socket files are refused, not silently dropped, so a caller cannot
// believe they were captured.
import { HomectlError } from "../types";

const MAX_PATH_LENGTH = 1024;

// Matched against the snapshot-relative path, case-insensitively (Windows).
export const EXCLUDE_PATTERNS: readonly RegExp[] = [
  /\.session$/i,
  /\.sock$/i,
  /\.lock$/i,
  /(^|\/)secrets-ephemeral\//i,
  /(^|\/)approvals-pending\//i,
];

// Snapshot paths are relative, POSIX-style and never escape the snapshot root.
export function assertSafePath(path: string): void {
  if (typeof path !== "string" || path.length === 0)
    throw new HomectlError(2, "Backup path must be a non-empty string");
  if (path.length > MAX_PATH_LENGTH)
    throw new HomectlError(2, "Backup path is too long");
  if (path.includes("\0") || path.includes("\\"))
    throw new HomectlError(2, "Backup path must use forward slashes only");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    throw new HomectlError(2, "Backup path must be relative");
  if (
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new HomectlError(
      2,
      "Backup path must not contain '..' or empty segments",
    );
}

export function isExcluded(path: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(path));
}

export function assertNotExcluded(path: string): void {
  if (isExcluded(path))
    throw new HomectlError(
      3,
      `Backup refuses runtime or ephemeral data: ${path}`,
    );
}
