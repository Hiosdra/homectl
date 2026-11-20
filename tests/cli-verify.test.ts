// `home-ctl verify` against a real daemon, in process. The agent's report is
// recorded once and shown by op and wait, but it never changes the state, the
// exit status or the command's own output. Bad arguments fail before any call.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBroker } from "../src/broker/client";
import { startDaemon } from "../src/broker/daemon";
import { FileVerifier } from "../src/broker/owner";
import { compatPaths } from "../src/broker/paths";
import { brokerCommand } from "../src/cli/broker-commands";
import {
  parseVerify,
  verificationNote,
  VERIFY_USAGE,
} from "../src/cli/verify-command";
import { HomectlError } from "../src/types";

let dir: string;
let stop: (() => Promise<void>) | undefined;
const PASSWORD = "owner password for tests";
const saved = {
  token: process.env.HOMECTL_TOKEN,
  endpoint: process.env.HOMECTL_BROKER_ENDPOINT,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "homectl-cli-verify-"));
  await writeFile(
    join(dir, "inventory.yaml"),
    "version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n",
  );
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  if (saved.token === undefined) delete process.env.HOMECTL_TOKEN;
  else process.env.HOMECTL_TOKEN = saved.token;
  if (saved.endpoint === undefined) delete process.env.HOMECTL_BROKER_ENDPOINT;
  else process.env.HOMECTL_BROKER_ENDPOINT = saved.endpoint;
  await rm(dir, { recursive: true, force: true });
});

// Starts a daemon with one granted host and one agent client, and points the
// CLI at it with the agent's token, as `agent connect` would.
async function boot() {
  const inventoryPath = join(dir, "inventory.yaml");
  const daemon = await startDaemon({
    mode: "compat",
    ...compatPaths(inventoryPath),
    inventoryPath,
    sshConfigPath: join(dir, "ssh_config"),
    executor: {
      run: async () => ({ exitCode: 0, stdout: "fine", stderr: "" }),
    },
  });
  stop = daemon.stop;
  await new FileVerifier(join(compatPaths(inventoryPath).state, "owner.json"), {
    iterations: 1,
    memorySize: 1024,
    parallelism: 1,
  }).set(PASSWORD);
  const { token: owner } = await callBroker<{ token: string }>(
    "/v1/owner/login",
    { password: PASSWORD },
    { endpoint: daemon.endpoint },
  );
  const created = await callBroker<{ token: string }>(
    "/v1/owner/clients/create",
    { id: "codex-pc", name: "Codex", hosts: ["pc"], password: PASSWORD },
    {
      endpoint: daemon.endpoint,
      authorization: `Owner ${owner}`,
    },
  );
  process.env.HOMECTL_BROKER_ENDPOINT = compatPaths(inventoryPath).endpoint;
  process.env.HOMECTL_TOKEN = created.token;
  return { inventoryPath };
}

type Seen = { value: unknown; human?: string }[];
function operationId(seen: Seen): string {
  const view = seen[0]?.value as { id: string } | undefined;
  if (!view) throw new Error("the command printed no operation");
  return view.id;
}
function cliFor(inventoryPath: string) {
  const seen: Seen = [];
  const run = (args: string[]) =>
    brokerCommand(args, {
      inventoryPath,
      json: false,
      emit: (value, human) => {
        seen.push({ value, human });
      },
    });
  return { seen, run };
}

describe("verify arguments", () => {
  test("the operation, a verdict and a summary are required", () => {
    expect(parseVerify(["op1", "passed"], "hostname answers")).toEqual({
      id: "op1",
      status: "passed",
      summary: "hostname answers",
    });
    expect(() => parseVerify(["op1", "passed"], undefined)).toThrow(
      "--summary",
    );
    expect(() => parseVerify(["op1", "passed"], "  ")).toThrow("--summary");
    expect(() => parseVerify(["op1"], "x")).toThrow(VERIFY_USAGE);
    expect(() => parseVerify(["op1", "passed", "extra"], "x")).toThrow(
      VERIFY_USAGE,
    );
  });

  test("only passed, failed or inconclusive are verdicts", () => {
    for (const status of ["ok", "success", "PASSED"])
      expect(() => parseVerify(["op1", status], "x")).toThrow(
        "passed, failed or inconclusive",
      );
  });

  test("a usage error is reported before any broker call", async () => {
    // No broker and no token: a bad command still fails as a usage error.
    delete process.env.HOMECTL_TOKEN;
    const { run } = cliFor(join(dir, "inventory.yaml"));
    const error = await run(["verify", "op1", "maybe", "--summary", "x"]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HomectlError);
    expect((error as HomectlError).code).toBe(2);
  });

  test("the agent note is labelled as not the exit status", () => {
    expect(verificationNote({})).toBeUndefined();
    expect(
      verificationNote({
        verification: { status: "failed", summary: "502 on /health" },
      }),
    ).toBe("Agent check (not the exit status): failed - 502 on /health");
  });
});

describe("verify against the daemon", () => {
  test("the report is recorded once and shown by op and wait; state and exit code stay", async () => {
    const { inventoryPath } = await boot();
    const cli = cliFor(inventoryPath);

    expect(await cli.run(["exec", "pc", "--", "hostname"])).toBe(0);
    const id = operationId(cli.seen);

    const reported = cliFor(inventoryPath);
    expect(
      await reported.run([
        "verify",
        id,
        "failed",
        "--summary",
        "hostname answers, but the wrong name",
      ]),
    ).toBe(0);
    const note = reported.seen[0]?.human ?? "";
    expect(note).toContain(`Recorded your check of ${id} as failed`);
    expect(note).toContain("exit status are unchanged");
    expect(reported.seen[0]?.value).toMatchObject({
      state: "succeeded",
      verification: { status: "failed" },
    });

    // The command's own output and exit code are unchanged.
    const op = cliFor(inventoryPath);
    expect(await op.run(["op", id])).toBe(0);
    expect(op.seen[0]?.human).toBe(
      "fine\nAgent check (not the exit status): failed - hostname answers, but the wrong name",
    );
    const waited = cliFor(inventoryPath);
    expect(await waited.run(["wait", id, "--wait", "5"])).toBe(0);
    expect(waited.seen[0]?.value).toMatchObject({
      state: "succeeded",
      result: { exitCode: 0 },
    });

    await expect(
      cliFor(inventoryPath).run([
        "verify",
        id,
        "passed",
        "--summary",
        "second try",
      ]),
    ).rejects.toThrow("already verified");
  });

  test("an unknown operation cannot be verified", async () => {
    const { inventoryPath } = await boot();
    const cli = cliFor(inventoryPath);
    await expect(
      cli.run(["verify", "missing-op", "passed", "--summary", "too early"]),
    ).rejects.toThrow("Unknown operation");
  });
});
