// Text checks for the container smoke test and its workflow. The image itself is run
// by scripts/container-smoke.sh (locally with Docker, and in container.yml).
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const read = (...parts: string[]) => readFile(join(REPO, ...parts), "utf8");

describe("container smoke script", () => {
  test("runs the 0.3 default (broker + panel) and serve --container", async () => {
    const text = await read("scripts", "container-smoke.sh");
    expect(text).toMatch(/smoke default \/app\/docker\/healthcheck\.ts/);
    expect(text).toMatch(/smoke serve \/app\/src\/container\/health\.ts/);
    expect(text).toContain("serve --container");
  });

  test("the default run passes no arguments, so the entrypoint starts the broker and panel", async () => {
    const text = await read("scripts", "container-smoke.sh");
    expect(text).toMatch(/smoke default \S+ no$/m);
    expect(text).toContain('"$img" "$@"');
  });

  test("both runs keep the NAS hardening: read-only root, no capabilities, no new privileges", async () => {
    const text = await read("scripts", "container-smoke.sh");
    const runs = text.match(/docker run -d .*$/gm) ?? [];
    expect(runs.length).toBe(1);
    expect(runs[0]).toContain("--read-only");
    expect(runs[0]).toContain("--cap-drop ALL");
    expect(runs[0]).toContain("no-new-privileges:true");
  });

  test("the workflow runs the smoke script on pull requests that touch the container files", async () => {
    const text = await read(".github", "workflows", "container.yml");
    expect(text).toContain("bash scripts/container-smoke.sh homectl-smoke:ci");
    expect(text).toContain('"docker/**"');
    expect(text).toContain('"scripts/container-smoke.sh"');
  });

  test("the workflow pins the Bun base image by a full sha256 digest", async () => {
    const text = await read(".github", "workflows", "container.yml");
    expect(text).toMatch(/BUN_IMAGE: oven\/bun@sha256:[0-9a-f]{64}$/m);
  });
});
