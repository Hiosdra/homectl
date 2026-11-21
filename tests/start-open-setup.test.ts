// Where `home-ctl start` (and the end of `home-ctl setup`, which calls it) opens the
// panel: the guided setup while setup is incomplete, the inbox once it is complete.
// Only the section name is added to the address.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openingHash } from "../src/cli/start-command";

let state: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "hcopen-"));
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});

describe("home-ctl start: where the browser opens", () => {
  test("a broker with no setup file opens the guided setup", async () => {
    expect(await openingHash(state)).toBe("#/setup");
  });

  test("an incomplete setup opens the guided setup", async () => {
    await writeFile(
      join(state, "setup.json"),
      JSON.stringify({ version: 1, welcomedAt: 5, steps: {} }),
    );
    expect(await openingHash(state)).toBe("#/setup");
  });

  test("a completed setup opens the inbox", async () => {
    await writeFile(
      join(state, "setup.json"),
      JSON.stringify({ version: 1, completedAt: 9, steps: {} }),
    );
    expect(await openingHash(state)).toBe("");
  });

  test("an unreadable setup file falls back to the guided setup", async () => {
    await writeFile(join(state, "setup.json"), "{not json");
    expect(await openingHash(state)).toBe("#/setup");
  });
});
