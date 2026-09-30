import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv } from "../src/credentials";
import { saveInventory } from "../src/inventory";
import { planExecution } from "../src/policies";
import type { Machine } from "../src/types";

const cli = join(import.meta.dir, "../src/cli/main.ts");
const machine: Machine = {
  description: "Test local host",
  transport: "local",
  access: "full",
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "homectl-cli-"));
  const path = join(dir, "inventory.yaml");
  await saveInventory(path, { version: 1, machines: { example: machine } });
  return path;
}
async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    code: await child.exited,
  };
}
test("help works without inventory or credentials", async () => {
  const r = await invoke(["help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("homectl");
});
test("missing inventory exits 2", async () => {
  const r = await invoke(["hosts", "--inventory", "/nonexistent-homectl-test"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Cannot read inventory");
});
test("JSON inventory inspection", async () => {
  const r = await invoke([
    "inspect",
    "example",
    "--json",
    "--inventory",
    await fixture(),
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).access).toBe("full");
});
test("unknown host exits 2", async () =>
  expect(
    (await invoke(["inspect", "missing", "--inventory", await fixture()])).code,
  ).toBe(2));
test("observe mutation exits 3", async () => {
  const path = await fixture();
  await saveInventory(path, {
    version: 1,
    machines: { example: { ...machine, access: "observe" } },
  });
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    path,
    "--",
    "rm",
    "fixture",
  ]);
  expect(r.code).toBe(3);
});
test("destruction exits 4 before any process executes", async () => {
  const r = await invoke([
    "exec",
    "example",
    "--json",
    "--inventory",
    await fixture(),
    "--",
    "rm",
    "/nonexistent-homectl-target",
  ]);
  expect(r.code).toBe(4);
  expect(JSON.parse(r.stderr).details.argv).toEqual([
    "rm",
    "/nonexistent-homectl-target",
  ]);
});
test("dry-run returns concrete effects and digest without files", async () => {
  const path = await fixture();
  const r = await invoke([
    "exec",
    "example",
    "--json",
    "--inventory",
    path,
    "--dry-run",
    "--impact",
    "Remove only fixture",
    "--",
    "rm",
    "fixture",
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).plan.approval).toHaveLength(64);
  expect(await Bun.file(`${path}.ssh_config`).exists()).toBe(false);
});
test("safe command emits result and exit 0", async () => {
  const r = await invoke([
    "exec",
    "example",
    "--json",
    "--inventory",
    await fixture(),
    "--",
    "uname",
    "-s",
  ]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).result.stdout).toBe("Linux\n");
});
test("remote failure exits 6 and preserves actual exit status", async () => {
  const path = await fixture();
  const argv = ["sh", "-c", "exit 7"];
  const approval = planExecution("example", machine, argv).approval;
  const r = await invoke([
    "exec",
    "example",
    "--json",
    "--inventory",
    path,
    "--approval",
    approval,
    "--",
    ...argv,
  ]);
  expect(r.code).toBe(6);
  expect(JSON.parse(r.stdout).result.exitCode).toBe(7);
});
test("spawn failure exits 5 without environment dumping", async () => {
  const path = await fixture();
  const argv = ["nonexistent-homectl-executable"];
  const r = await invoke([
    "exec",
    "example",
    "--inventory",
    path,
    "--approval",
    planExecution("example", machine, argv).approval,
    "--",
    ...argv,
  ]);
  expect(r.code).toBe(5);
  expect(r.stderr).toContain("details suppressed");
});
test("all SSH addresses regenerate from current inventory before diagnostics", async () => {
  const path = await fixture();
  await saveInventory(path, {
    version: 1,
    machines: {
      example: {
        description: "Example",
        transport: "ssh",
        ssh_alias: "example",
        address: "192.0.2.55",
        user: "operator",
        access: "user",
        auth: { type: "local-ssh-agent" },
      },
    },
  });
  await invoke(["doctor", "--inventory", path, "--json"]);
  expect(await readFile(`${path}.ssh_config`, "utf8")).toContain("192.0.2.55");
});
test("unknown flags cannot silently change CLI behavior", async () => {
  const r = await invoke(["hosts", "--yes", "--inventory", await fixture()]);
  expect(r.code).toBe(2);
});
