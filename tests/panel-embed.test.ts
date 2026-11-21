import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderEmbeddedModule } from "../src/web/embed";
import { embeddedPanel } from "../src/web/embedded";

import { buildOwnerScript } from "../src/web/owner/server";

describe("embedded web panel", () => {
  test("the committed placeholder is empty; a local release build may fill it", () => {
    if (embeddedPanel === undefined) expect(embeddedPanel).toBeUndefined();
    else
      expect(Object.keys(embeddedPanel).sort()).toEqual([
        "css",
        "html",
        "script",
      ]);
  });

  test("the generated module carries the panel text exactly", () => {
    const panel = {
      html: '<h1>"quoted" & <b>tags</b></h1>',
      css: "a{content:'\n'}",
      script: "console.log('line one\\nline two');",
    };
    const ownerScript = 'console.log("owner");';
    const text = renderEmbeddedModule(panel, ownerScript);
    // Only the value after `undefined = ` is JSON; the type line also has braces.
    const json = text.match(/embeddedPanel: .* = (\{.*\});/)?.[1];
    expect(JSON.parse(json ?? "null")).toEqual(panel);
    expect(text).toContain(
      `embeddedOwnerScript: string | undefined = ${JSON.stringify(ownerScript)};`,
    );
  });

  test("the owner panel builds for the browser", async () => {
    expect((await buildOwnerScript()).length).toBeGreaterThan(1000);
  });

  test("the panel source builds for the browser", async () => {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../src/web/app.tsx")],
      target: "browser",
      minify: true,
    });
    expect(built.success).toBe(true);
    expect((await built.outputs[0]?.text())?.length ?? 0).toBeGreaterThan(1000);
  });
});
