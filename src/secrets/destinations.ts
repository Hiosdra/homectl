// Destination validation. A destination is the only place a secret may go; the
// broker binds it at request time and compares it exactly at use time.

import type { SecretDestination } from "../core/contracts";
import { hasControlCharacter, isRecord, usageError } from "./validation";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const FILE_MODE = /^0[0-7]{3}$/;
const GROUP_OTHER_WRITE = 0o022;
const MAX_ARGV = 64;
const MAX_ARG_CHARS = 4096;
const MAX_URL_CHARS = 2048;
const MAX_PATH_CHARS = 1024;

export function checkHost(
  value: unknown,
  knownHost: (host: string) => boolean,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255)
    throw usageError("destination host is invalid");
  if (!knownHost(value))
    throw usageError("destination host is not a known inventory host");
  return value;
}

export function checkArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ARGV)
    throw usageError(`argv must list 1 to ${MAX_ARGV} arguments`);
  const list: readonly unknown[] = value;
  return list.map((arg) => {
    if (
      typeof arg !== "string" ||
      arg.length > MAX_ARG_CHARS ||
      /[\0\r\n]/.test(arg)
    )
      throw usageError("argv entries must be strings without NUL, CR or LF");
    return arg;
  });
}

// https only. Plain http is allowed for loopback addresses. Userinfo is refused
// outright, so "https://allowed.example@evil.example" style URLs never pass.
export function checkHttpUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_URL_CHARS ||
    /[\s\\]/.test(value) ||
    hasControlCharacter(value)
  )
    throw usageError("destination URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageError("destination URL is invalid");
  }
  if (url.username !== "" || url.password !== "")
    throw usageError("destination URL must not contain credentials");
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
    return url.href;
  throw usageError("destination URL must be https (http only for loopback)");
}

export function checkHeaderName(value: unknown): string {
  if (typeof value !== "string" || !HEADER_TOKEN.test(value))
    throw usageError("header name must be an RFC 7230 token");
  return value;
}

// Absolute POSIX path. No "..", ".", empty segments, or trailing slash.
export function checkAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > MAX_PATH_CHARS ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  )
    throw usageError("target path must be an absolute POSIX path");
  const parts = value.slice(1).split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw usageError(
      "target path must not contain empty, '.' or '..' segments",
    );
  return value;
}

export function checkFileMode(value: unknown): string {
  if (typeof value !== "string" || !FILE_MODE.test(value))
    throw usageError("file mode must match 0NNN");
  if ((Number.parseInt(value, 8) & GROUP_OTHER_WRITE) !== 0)
    throw usageError("file mode must not grant group or other write");
  return value;
}

// Parses untrusted input into a normalized destination. `knownHost` is the
// broker's inventory check; the pure injection path reuses the other checks.
export function normalizeDestination(
  value: unknown,
  knownHost: (host: string) => boolean,
): SecretDestination {
  if (!isRecord(value)) throw usageError("destination must be an object");
  switch (value.kind) {
    case "ssh-stdin":
      return {
        kind: "ssh-stdin",
        host: checkHost(value.host, knownHost),
        argv: checkArgv(value.argv),
      };
    case "http-header":
      return {
        kind: "http-header",
        url: checkHttpUrl(value.url),
        header: checkHeaderName(value.header),
      };
    case "target-file":
      return {
        kind: "target-file",
        host: checkHost(value.host, knownHost),
        path: checkAbsolutePath(value.path),
        mode: checkFileMode(value.mode),
      };
    case "vault-only":
      return { kind: "vault-only" };
    default:
      throw usageError("unknown destination kind");
  }
}

// Canonical key for exact comparison. Two destinations match only when every
// field is identical, argv order included.
export function destinationKey(destination: SecretDestination): string {
  switch (destination.kind) {
    case "ssh-stdin":
      return JSON.stringify([
        destination.kind,
        destination.host,
        destination.argv,
      ]);
    case "http-header":
      return JSON.stringify([
        destination.kind,
        destination.url,
        destination.header,
      ]);
    case "target-file":
      return JSON.stringify([
        destination.kind,
        destination.host,
        destination.path,
        destination.mode,
      ]);
    case "vault-only":
      return JSON.stringify([destination.kind]);
  }
}

export function cloneDestination(
  destination: SecretDestination,
): SecretDestination {
  switch (destination.kind) {
    case "ssh-stdin":
      return { ...destination, argv: [...destination.argv] };
    case "http-header":
    case "target-file":
      return { ...destination };
    case "vault-only":
      return { kind: "vault-only" };
  }
}
