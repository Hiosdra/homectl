import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { atomicReplace } from "../platform";

// Returns undefined when the file does not exist yet.
export async function readTextIfExists(
  path: string,
): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Writes a temp file beside the target and renames it into place, so readers
// see either the old or the new content, never a partial write.
export async function writeTextAtomic(
  path: string,
  text: string,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await atomicReplace(temp, path);
}
