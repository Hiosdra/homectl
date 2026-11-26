// Shared helpers for the host permission module. Pure except runStep, which
// calls RemoteExec and records a StepReport without remote output.
import { createHash } from "node:crypto";
import { HomectlError } from "../types";
import type { OsFamily, RemoteExec, StepReport } from "./types";

export const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Privileged argv: always non-interactive sudo, never a shell string.
export function sudo(argv: string[]): string[] {
  return ["sudo", "-n", ...argv];
}

export function assertAccountName(user: string): void {
  if (!USER_RE.test(user))
    throw new HomectlError(
      2,
      "Invalid account name: use lowercase letters, digits, '_' or '-' (max 32)",
    );
  if (user === "root")
    throw new HomectlError(
      2,
      "Refusing to manage root: a root SSH account already has root authority",
    );
}

export function assertGrantId(id: string): void {
  if (!ID_RE.test(id)) throw new HomectlError(2, "Invalid grant id");
}

// Group that owns root-owned system files on each platform.
export function rootGroup(os: OsFamily): string {
  return os === "linux" ? "root" : "wheel";
}

// Native file-hash command per platform (no extra software on the host).
export function fileHashArgv(os: OsFamily, path: string): string[] {
  switch (os) {
    case "linux":
      return ["sha256sum", path];
    case "darwin":
      return ["shasum", "-a", "256", path];
    case "freebsd":
      return ["sha256", "-q", path];
    default:
      throw new HomectlError(3, "No native file hash command for this OS");
  }
}

export function firstToken(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}

// Lines without the phantom empty element produced by a trailing newline.
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface StepOutcome {
  ok: boolean;
  stdout: string;
}

// Runs one argv, records it, and returns the outcome. The detail never
// contains remote output, so visudo or cat content cannot leak into reports.
export async function runStep(
  exec: RemoteExec,
  steps: StepReport[],
  id: string,
  argv: string[],
  stdin?: string,
): Promise<StepOutcome> {
  const result = await exec(argv, stdin === undefined ? undefined : { stdin });
  const ok = result.exitCode === 0;
  steps.push({
    id,
    argv: [...argv],
    ok,
    detail: ok ? "ok" : `exit ${result.exitCode}`,
  });
  return { ok, stdout: result.stdout };
}

// Simple line diff: "- " for removed lines, "+ " for added lines, common lines
// omitted. Falls back to a set comparison for very large inputs.
export function lineDiff(before: string, after: string): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: string[] = [];
  if (a.length * b.length > 4_000_000) {
    const inA = new Set(a);
    const inB = new Set(b);
    for (const line of a) if (!inB.has(line)) out.push(`- ${line}`);
    for (const line of b) if (!inA.has(line)) out.push(`+ ${line}`);
    return out.join("\n");
  }
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push(`- ${a[i] ?? ""}`);
      i++;
    } else {
      out.push(`+ ${b[j] ?? ""}`);
      j++;
    }
  }
  for (; i < n; i++) out.push(`- ${a[i] ?? ""}`);
  for (; j < m; j++) out.push(`+ ${b[j] ?? ""}`);
  return out.join("\n");
}
