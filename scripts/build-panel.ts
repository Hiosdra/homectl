// Builds the web panel and embeds it in src/web/embedded.ts, so that a compiled
// executable can serve it. Run before `bun build --compile`:
//   bun run build:panel && bun build --compile src/cli/main.ts --outfile homectl
// The committed embedded.ts stays a placeholder; restore it after a release build.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderEmbeddedModule } from "../src/web/embed";

const web = resolve(import.meta.dir, "../src/web");
const built = await Bun.build({
  entrypoints: [resolve(web, "app.ts")],
  target: "browser",
  minify: true,
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const script = await built.outputs[0]?.text();
if (script === undefined) throw new Error("The panel build produced no script");
const html = await readFile(resolve(web, "index.html"), "utf8");
const css = await readFile(resolve(web, "style.css"), "utf8");
await writeFile(
  resolve(web, "embedded.ts"),
  renderEmbeddedModule({ html, css, script }),
);
console.log(`Embedded the web panel: ${script.length} bytes of script`);
