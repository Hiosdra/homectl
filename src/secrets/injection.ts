// Injection planning. Pure: no I/O and no clock. Given a validated destination
// and values, it returns the exact argv, stdin, URL and headers to use. The
// secret never appears in argv or in a URL; the planner throws if it would.

import type { SecretDestination } from "../core/contracts";
import {
  checkAbsolutePath,
  checkArgv,
  checkFileMode,
  checkHeaderName,
  checkHttpUrl,
} from "./destinations";
import { canaryLeaks } from "./redaction";
import { FIELD_NAME_PATTERN, MAX_VALUE_CHARS } from "./types";
import { isRecord, refusal, usageError } from "./validation";

export interface InjectionStep {
  argv: string[];
  stdin?: string;
}

export type InjectionPlan =
  | { kind: "ssh-stdin"; host: string; argv: string[]; stdin: string }
  | { kind: "http-header"; url: string; headers: Record<string, string> }
  | {
      kind: "target-file";
      host: string;
      steps: [
        { argv: string[]; stdin: string },
        { argv: string[]; stdin?: undefined },
      ];
    };

function checkHostShape(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255)
    throw usageError("destination host is invalid");
  return value;
}

// Sorted by name so that the same values always produce the same stdin.
function sortedEntries(values: unknown): [string, string][] {
  if (!isRecord(values)) throw usageError("values must be an object");
  const names = Object.keys(values).sort();
  if (names.length < 1) throw usageError("values must not be empty");
  return names.map((name): [string, string] => {
    const value = values[name];
    if (!FIELD_NAME_PATTERN.test(name)) throw usageError("invalid field name");
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAX_VALUE_CHARS ||
      value.includes("\0")
    )
      throw usageError(`value for field ${name} is invalid`);
    return [name, value];
  });
}

// One field: the bare value (it may be a multi-line key). Several fields:
// "name=value" lines, which cannot carry line breaks inside a value.
function stdinFor(entries: [string, string][]): string {
  const [only] = entries;
  if (entries.length === 1 && only) return only[1];
  return entries
    .map(([name, value]) => {
      if (/[\r\n]/.test(value))
        throw usageError(
          "multi-field values cannot contain line breaks; use one field per secret",
        );
      return `${name}=${value}\n`;
    })
    .join("");
}

function assertNoLeak(texts: string[], secrets: string[]): void {
  if (canaryLeaks(texts, secrets).length > 0)
    throw refusal("secret value would appear in a command argument or URL");
}

export function injectionPlan(
  destination: SecretDestination,
  values: Record<string, string>,
): InjectionPlan {
  const entries = sortedEntries(values);
  const secrets = entries.map(([, value]) => value);
  switch (destination.kind) {
    case "ssh-stdin": {
      const argv = checkArgv(destination.argv);
      const host = checkHostShape(destination.host);
      assertNoLeak(argv, secrets);
      return { kind: "ssh-stdin", host, argv, stdin: stdinFor(entries) };
    }
    case "http-header": {
      const url = checkHttpUrl(destination.url);
      const header = checkHeaderName(destination.header);
      if (entries.length !== 1)
        throw usageError("http-header destinations take exactly one field");
      const [only] = entries;
      if (!only) throw usageError("values must not be empty");
      const value = only[1];
      if (/[\0\r\n]/.test(value))
        throw usageError("header values cannot contain NUL, CR or LF");
      assertNoLeak([url], secrets);
      return { kind: "http-header", url, headers: { [header]: value } };
    }
    case "target-file": {
      const host = checkHostShape(destination.host);
      const path = checkAbsolutePath(destination.path);
      const mode = checkFileMode(destination.mode);
      // Both steps only ever carry the path and mode in argv.
      assertNoLeak([path, mode], secrets);
      return {
        kind: "target-file",
        host,
        steps: [
          {
            argv: ["dd", `of=${path}`, "status=none"],
            stdin: stdinFor(entries),
          },
          { argv: ["chmod", mode, path] },
        ],
      };
    }
    case "vault-only":
      throw usageError("vault-only destinations have no injection plan");
  }
}
