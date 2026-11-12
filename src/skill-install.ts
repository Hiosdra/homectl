import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bundled } from "./internal";
import { bundledSkills, skillContents } from "./skills-bundle";
import { HomectlError } from "./types";

// A skill folder that setup copied from the executable holds this file: the SHA-256 of each
// file as setup last wrote it. A later setup replaces a file only while it still has that
// hash, so hand edits are never overwritten.
export const skillManifest = ".homectl-skill.json";

type Manifest = Record<string, string>;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const conflict = (path: string) =>
  new HomectlError(
    3,
    `Existing path conflicts: ${path}; it was changed or was not installed by homectl, and replacement requires separate explicit approval`,
  );

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readManifest(path: string): Promise<Manifest> {
  const text = await readText(path);
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object"
      ? (value as Manifest)
      : {};
  } catch {
    // An unreadable manifest vouches for nothing, so every existing file counts as edited.
    return {};
  }
}

// Copies the files of one skill into dest, the skill's folder. Files that already match are
// kept. Files that setup wrote and nobody changed are replaced. Anything else stops the
// install before a single file is written.
export async function installSkillCopy(
  dest: string,
  files: Record<string, string>,
) {
  const entry = await lstat(dest).catch(() => undefined);
  if (entry?.isSymbolicLink()) {
    // A link from an earlier checkout install points into the checkout. Keep it only when its
    // content already matches, and never write through it.
    for (const [path, content] of Object.entries(files))
      if ((await readText(join(dest, path))) !== content)
        throw conflict(join(dest, path));
    return;
  }

  const written = await readManifest(join(dest, skillManifest));
  const next: Manifest = {};
  const writes: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    next[path] = sha256(content);
    const current = await readText(join(dest, path));
    if (current === undefined) writes.push(path);
    else if (current === content) continue;
    else if (written[path] === sha256(current)) writes.push(path);
    else throw conflict(join(dest, path));
  }

  const manifestSame =
    Object.keys(next).length === Object.keys(written).length &&
    Object.entries(next).every(([path, hash]) => written[path] === hash);
  if (writes.length === 0 && manifestSame) return;

  await mkdir(dest, { recursive: true, mode: 0o700 });
  for (const path of writes) {
    await mkdir(dirname(join(dest, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(dest, path), files[path] ?? "", "utf8");
  }
  await writeFile(
    join(dest, skillManifest),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
}

// Copies every bundled skill into the Codex and Claude Code skill folders under home.
export async function installBundledSkills(home: string) {
  for (const platform of [".agents", ".claude"]) {
    const dest = join(home, platform, "skills");
    await mkdir(dest, { recursive: true, mode: 0o700 });
    for (const skill of bundledSkills)
      await installSkillCopy(
        join(dest, skill.name),
        await skillContents(skill),
      );
  }
}

// The internal role `home-ctl __internal refresh-skills`. An update runs it in the new release
// so that the skills come from that release. It prints one JSON line and returns the exit code.
export async function refreshSkills(home = homedir()): Promise<number> {
  if (!bundled) {
    console.error(
      JSON.stringify({
        error: "Only a release executable carries skills to copy.",
        code: 2,
      }),
    );
    return 2;
  }
  try {
    await installBundledSkills(home);
    console.log(JSON.stringify({ skills: "refreshed" }));
    return 0;
  } catch (error) {
    if (!(error instanceof HomectlError)) throw error;
    console.error(JSON.stringify({ error: error.message, code: error.code }));
    return error.code;
  }
}

// Refreshes the copies that homectl installed earlier, when this release carries newer skills.
// Only a folder with a manifest is touched, so a home without skills gets none. A copy edited
// by hand is kept, and a failure is ignored: no command should fail over a skill copy.
export async function refreshManagedCopies(home = homedir()) {
  for (const platform of [".agents", ".claude"])
    for (const skill of bundledSkills) {
      const dest = join(home, platform, "skills", skill.name);
      try {
        if ((await readText(join(dest, skillManifest))) !== undefined)
          await installSkillCopy(dest, await skillContents(skill));
      } catch {
        // Edited or unreadable: `home-ctl setup` reports it.
      }
    }
}

// Runs at the start of every command. A package-manager or Homebrew update replaces the
// executable without running setup, so the first command after it refreshes the skills here.
// A source checkout links its skills and needs nothing.
export async function refreshManagedSkills(home = homedir()) {
  if (bundled) await refreshManagedCopies(home);
}
