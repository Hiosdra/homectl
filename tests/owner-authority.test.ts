// The reviewer authority choice shared by `owner init` and `daemon install`
// (src/cli/owner-commands.ts). recommend is the default and writes nothing; a wider
// choice goes into policy.json of the state directory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/authz";
import { saveReviewerAuthority } from "../src/cli/owner-commands";

let state: string;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "homectl-authority-"));
});

afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});

describe("saveReviewerAuthority", () => {
  test("recommend keeps the default and writes no policy file", async () => {
    expect(await saveReviewerAuthority(state, "recommend")).toBe(false);
    expect(existsSync(join(state, "policy.json"))).toBe(false);
  });

  test("routine is written to policy.json and keeps the rest of the default policy", async () => {
    expect(await saveReviewerAuthority(state, "routine")).toBe(true);
    const policy = await loadPolicy(join(state, "policy.json"));
    expect(policy.reviewer.authority).toBe("routine");
    expect(policy.reviewer.fallback).toBe("ask");
    expect(policy.rules.length).toBeGreaterThan(0);
  });

  test("delegated is written as the wider choice", async () => {
    expect(await saveReviewerAuthority(state, "delegated")).toBe(true);
    const policy = await loadPolicy(join(state, "policy.json"));
    expect(policy.reviewer.authority).toBe("delegated");
  });
});
