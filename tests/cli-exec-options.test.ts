import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv } from "../src/credentials";
import { saveInventory } from "../src/inventory";
import type { Machine } from "../src/types";

// Regression tests for the 0.3.0 CLI help and exec option bugs: `exec --wait`
// used to fail with "Unknown option" on the local path, `--task` was silently
// misread there, and the help still described the removed --approval digest.
const cli = join(import.meta.dir, "../src/cli/main.ts");
const machine: Machine = {
  description: "Test local host",
  transport: "local",
  access: "full",
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-exec-opts-"));
  const path = join(dir, "inventory.yaml");
  await saveInventory(path, { version: 1, machines: { example: machine } });
  return path;
}

async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    code: await child.exited,
  };
}

test("exec accepts --wait on the local path instead of failing as unknown", async () => {
  const inventory = await fixture();
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    inventory,
    "--dry-run",
    "--wait",
    "0",
    "--",
    "mkdir",
    "-p",
    "/x",
  ]);
  expect(r.stderr).not.toContain("Unknown option");
  expect(r.code).toBe(0);
});

test("exec --wait outside 0 to 600 seconds is refused with the range", async () => {
  const inventory = await fixture();
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    inventory,
    "--wait",
    "700",
    "--",
    "true",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--wait takes 0 to 600 seconds");
});

test("exec --task without a broker says it needs the broker", async () => {
  const inventory = await fixture();
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    inventory,
    "--task",
    "T1",
    "--",
    "true",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--task needs the homectl broker");
});

test("exec --dry-run labels the fingerprint as a plan fingerprint, not an approval", async () => {
  const inventory = await fixture();
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    inventory,
    "--dry-run",
    "--",
    "uname",
    "-s",
  ]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("Plan fingerprint:");
  expect(r.stdout).not.toMatch(/^\s*approval\s*:/m);
});

test("help for exec and approve no longer describes the removed digest flow", async () => {
  const exec = await invoke(["help", "exec"]);
  expect(exec.stdout).toContain("--wait SECONDS");
  expect(exec.stdout).not.toContain("passing the digest");
  // Help wraps long lines, so match the command name and the placeholder apart.
  expect(exec.stdout).toMatch(/home-ctl approve\s+<operation>/);
  const approve = await invoke(["help", "approve"]);
  expect(approve.stdout).not.toContain("removed in 0.3.0");
});
