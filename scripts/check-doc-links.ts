// Fails when a relative Markdown link or image in README.md, docs/ or skills/
// points at a missing file, or at a #heading that the target Markdown file does
// not have. Slugs follow GitHub: lowercase, punctuation removed (except - and _),
// spaces become -, and repeated headings get -1, -2, and so on. External links
// (http, https, mailto) are not fetched. Problems are printed as file:line and
// the script exits 1.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const EXTERNAL = /^(https?:|mailto:)/i;

export interface Problem {
  file: string;
  line: number;
  target: string;
  reason: string;
}

interface Line {
  line: number;
  raw: string;
  // Same text with inline code blanked, so backticks are not read as links.
  prose: string;
}

// Lines outside fenced code blocks.
function lines(text: string): Line[] {
  const out: Line[] = [];
  let fenced = false;
  text.split("\n").forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    out.push({
      line: index + 1,
      raw,
      prose: raw.replace(/`[^`]*`/g, (match) => " ".repeat(match.length)),
    });
  });
  return out;
}

export function slugify(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function anchorsOf(text: string): Set<string> {
  const counts = new Map<string, number>();
  const anchors = new Set<string>();
  for (const { raw } of lines(text)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (!heading?.[1]) continue;
    const base = slugify(heading[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

export function checkFile(relative: string, text: string): Problem[] {
  const problems: Problem[] = [];
  const here = dirname(join(ROOT, relative));
  for (const { line, prose } of lines(text)) {
    for (const match of prose.matchAll(LINK)) {
      const target = match[1] ?? "";
      if (EXTERNAL.test(target)) continue;
      const hash = target.indexOf("#");
      const rawPath = hash < 0 ? target : target.slice(0, hash);
      const anchor =
        hash < 0 ? undefined : safeDecode(target.slice(hash + 1)).toLowerCase();
      const pathPart = safeDecode(rawPath);
      const fail = (reason: string) =>
        problems.push({ file: relative, line, target, reason });
      if (pathPart === null || anchor === null) {
        fail("malformed URL encoding");
        continue;
      }
      const absolute =
        pathPart === ""
          ? join(ROOT, relative)
          : pathPart.startsWith("/")
            ? join(ROOT, pathPart)
            : resolve(here, pathPart);
      if (!existsSync(absolute)) {
        fail("target file does not exist");
        continue;
      }
      if (
        anchor !== undefined &&
        absolute.endsWith(".md") &&
        statSync(absolute).isFile() &&
        !anchorsOf(readFileSync(absolute, "utf8")).has(anchor)
      )
        fail(`no heading for #${anchor}`);
    }
  }
  return problems;
}

function countLinks(text: string): number {
  let count = 0;
  for (const { prose } of lines(text))
    count += [...prose.matchAll(LINK)].length;
  return count;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const files = ["README.md"];
  for (const pattern of ["docs/**/*.md", "skills/**/*.md"]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: ROOT }))
      files.push(file.replaceAll("\\", "/"));
  }
  const problems: Problem[] = [];
  let links = 0;
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    links += countLinks(text);
    problems.push(...checkFile(file, text));
  }
  if (problems.length) {
    for (const p of problems)
      console.error(`${p.file}:${p.line}: ${p.target} (${p.reason})`);
    console.error(`Doc links: ${problems.length} problem(s).`);
    return 1;
  }
  console.log(
    `Doc links OK (${files.length} files, ${links} relative or external links checked).`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
