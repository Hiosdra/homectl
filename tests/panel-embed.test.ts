import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderEmbeddedModule } from "../src/web/embed";
import { embeddedPanel } from "../src/web/embedded";

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
    const text = renderEmbeddedModule(panel);
    // Only the value after `undefined = ` is JSON; the type line also has braces.
    const json = text.match(/undefined = (\{.*\});\n$/s)?.[1];
    expect(JSON.parse(json ?? "null")).toEqual(panel);
    expect(text).toContain("export const embeddedPanel");
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
