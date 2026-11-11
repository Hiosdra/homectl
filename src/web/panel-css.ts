import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { compile } from "tailwindcss";

// Builds the panel stylesheet with Tailwind v4 in plain JavaScript. The candidate class
// names come from the panel sources, so no native module is needed at run time, and a
// compiled homectl embeds the same CSS that a source checkout builds.
const webRoot = import.meta.dir;

// Stylesheets the panel imports from packages. Bun does not follow the `style` export
// condition these packages use, so the file is found by its path in node_modules.
const PACKAGE_STYLESHEETS: Record<string, string> = {
  tailwindcss: "index.css",
  "tw-animate-css": "dist/tw-animate.css",
};

export async function buildPanelCss(): Promise<string> {
  const source = readFileSync(join(webRoot, "app.css"), "utf8");
  const compiled = await compile(source, {
    base: webRoot,
    loadStylesheet: async (id, base) => {
      const path = stylesheetPath(id, base);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiled.build(panelCandidates(webRoot));
}

function stylesheetPath(id: string, base: string): string {
  if (id.startsWith(".") || id.startsWith("/")) return resolve(base, id);
  const [name = "", ...rest] = id.split("/");
  const entry = rest.length > 0 ? rest.join("/") : PACKAGE_STYLESHEETS[name];
  if (entry === undefined) throw new Error(`Unknown stylesheet import: ${id}`);
  return join(packageDir(name, base), entry);
}

function packageDir(name: string, from: string): string {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Package not installed: ${name}`);
    dir = parent;
  }
}

// Every whitespace- or quote-delimited token in the panel sources is a candidate. Tailwind
// ignores tokens that are not utilities, so over-matching costs only a few bytes.
function panelCandidates(directory: string): string[] {
  const tokens = new Set<string>();
  for (const file of sourceFiles(directory)) {
    for (const token of readFileSync(file, "utf8").split(/[\s"'`{}<>]+/))
      if (token.length > 0) tokens.add(token);
  }
  return [...tokens];
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (
      [".ts", ".tsx"].includes(extname(entry)) &&
      entry !== "embedded.ts"
    ) {
      files.push(path);
    }
  }
  return files;
}
