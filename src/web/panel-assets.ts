import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bundled } from "../internal";
import { HomectlError } from "../types";
import { embeddedPanel } from "./embedded";

// The panel assets. A compiled release carries them (src/web/embedded.ts, written
// by `bun run build:panel`). A source checkout builds the panel from web/ at run time.
export async function panelAssets(): Promise<{
  html: string;
  css: string;
  script: string;
}> {
  if (bundled) {
    if (embeddedPanel === undefined)
      throw new HomectlError(
        5,
        "This build has no embedded web panel. Run bun run build:panel before bun build --compile.",
      );
    return embeddedPanel;
  }
  const js = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "app.tsx")],
    target: "browser",
    minify: true,
  });
  if (!js.success) throw new HomectlError(5, "Frontend build failed");
  const script = await js.outputs[0]?.text();
  if (script === undefined) throw new HomectlError(5, "Frontend build failed");
  return {
    html: await readFile(resolve(import.meta.dir, "index.html"), "utf8"),
    css: await readFile(resolve(import.meta.dir, "style.css"), "utf8"),
    script,
  };
}
