// Policy file store: strict JSON, 0600, atomic replace, optimistic revision.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../control/file-lock";
import type { PolicyDocument } from "../core/contracts";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import { validatePolicy } from "./validate";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readPolicy(path: string): Promise<PolicyDocument | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new HomectlError(5, "Policy file could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HomectlError(5, "Policy file is not valid JSON");
  }
  return validatePolicy(parsed);
}

export async function loadPolicy(path: string): Promise<PolicyDocument> {
  const policy = await readPolicy(path);
  if (policy === undefined) throw new HomectlError(5, "Policy file not found");
  return policy;
}

// Saves a policy and returns it with revision + 1. The caller must pass the
// revision it read; a mismatch means someone else saved first. A corrupt file
// is reported, never overwritten.
export async function savePolicy(
  path: string,
  doc: PolicyDocument,
): Promise<PolicyDocument> {
  // The revision check and the replace must not interleave with another
  // writer (panel, CLI and broker can all save).
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(`${path}.lock`, "Policy file", () =>
    saveUnlocked(path, doc),
  );
}

async function saveUnlocked(
  path: string,
  doc: PolicyDocument,
): Promise<PolicyDocument> {
  const candidate = validatePolicy(doc);
  const onDisk = await readPolicy(path);
  if (onDisk !== undefined && onDisk.revision !== candidate.revision)
    throw new HomectlError(
      5,
      `Policy changed on disk (revision ${onDisk.revision}); reload and retry`,
    );
  const saved: PolicyDocument = {
    ...candidate,
    revision: candidate.revision + 1,
  };
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = join(
    directory,
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temp, `${JSON.stringify(saved, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temp, 0o600).catch(() => undefined);
  await atomicReplace(temp, path);
  return saved;
}
