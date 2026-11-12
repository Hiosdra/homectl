import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const MAIN = join(REPO, "src", "cli", "main.ts");

describe("remote panel guard", () => {
  test("remote panel needs no access code: interface and origin are enough", async () => {
    const noCode = Bun.spawn(
      [
        process.execPath,
        MAIN,
        "serve",
        "--inventory",
        "unused-inventory.yaml",
        "--interface",
        "127.0.0.1",
        "--panel-interface",
        "127.0.0.2",
        "--panel-origin",
        "http://panel.example.test",
      ],
      { cwd: REPO, stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    expect(await noCode.exited).toBe(2);
    const stderr = await new Response(noCode.stderr).text();
    // The access code is optional, so the guard reaches the container-only check.
    expect(stderr).toContain(
      "Remote panel options apply only to serve --container",
    );
  });
});
