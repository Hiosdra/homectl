// Fails when a TypeScript source file is longer than MAX_LINES.
// Files that are already longer are listed in file-length-baseline.json at their
// current size. A listed file may shrink but never grow, and it must leave the
// list once it is back under the limit. New files get the full limit.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const MAX_LINES = 500;
const ROOTS = ["src", "tests", "scripts"];
const EXTENSIONS = [".ts", ".tsx"];

export type Problem = { file: string; message: string };

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

export function checkLengths(
  counts: Record<string, number>,
  baseline: Record<string, number>,
): Problem[] {
  const problems: Problem[] = [];
  for (const [file, lines] of Object.entries(counts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const allowed = baseline[file];
    if (allowed === undefined) {
      if (lines > MAX_LINES)
        problems.push({
          file,
          message: `${lines} lines; the limit is ${MAX_LINES}. Split the file.`,
        });
    } else if (lines > allowed) {
      problems.push({
        file,
        message: `${lines} lines; the baseline is ${allowed}. Split the file instead of growing it.`,
      });
    }
  }
  for (const file of Object.keys(baseline).sort()) {
    const lines = counts[file];
    if (lines === undefined)
      problems.push({
        file,
        message:
          "listed in the baseline but no longer exists. Remove the entry.",
      });
    else if (lines <= MAX_LINES)
      problems.push({
        file,
        message: `${lines} lines, back under ${MAX_LINES}. Remove the entry from the baseline.`,
      });
  }
  return problems;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist")
        files.push(...(await walk(path)));
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(path);
    }
  }
  return files;
}

export async function collectCounts(
  root: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const dir of ROOTS) {
    const absolute = resolve(root, dir);
    for (const file of await walk(absolute)) {
      const name = relative(root, file).split(sep).join("/");
      counts[name] = countLines(await readFile(file, "utf8"));
    }
  }
  return counts;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const baseline = JSON.parse(
    await readFile(join(root, "scripts", "file-length-baseline.json"), "utf8"),
  ) as Record<string, number>;
  const problems = checkLengths(await collectCounts(root), baseline);
  for (const problem of problems)
    console.error(`${problem.file}: ${problem.message}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} file-length problem(s).`);
    process.exit(1);
  }
  console.log(
    `File lengths OK (limit ${MAX_LINES}, ${Object.keys(baseline).length} grandfathered).`,
  );
}
