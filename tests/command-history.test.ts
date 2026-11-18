import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandHistoryStore,
  type LocalCommandHistoryInput,
  redactCommandHistoryArgv,
} from "../src/command-history";

function input(
  phase: LocalCommandHistoryInput["phase"],
  finishedAt: number,
  operationId: string,
): LocalCommandHistoryInput {
  return {
    inventoryPath: "inventory.yaml",
    host: "example",
    argv: ["run", "--safe"],
    phase,
    status: phase === "started" ? "executing" : "succeeded",
    policyDecision: "allowed",
    operationId,
    startedAt: phase === "outcome" ? finishedAt - 250 : undefined,
    finishedAt,
  };
}

function nonRootUid(): number | undefined {
  return process.getuid?.() === 0 ? 1000 : process.getuid?.();
}

const secretFlagCases: [string, string[]][] = [
  ["mysql attached -p value", ["mysql", "-pMySecret"]],
  ["sshpass attached -p value", ["sshpass", "-pMySecret", "ssh"]],
  ["curl short user password", ["curl", "-u", "admin:MySecret"]],
  ["curl long user password", ["curl", "--user", "admin:MySecret"]],
  ["URL userinfo", ["curl", "https://admin:MySecret@example.test/path"]],
  ["password label", ["tool", "password:", "MySecret"]],
  ["token label", ["tool", "token:", "MySecret"]],
  ["secret label", ["tool", "secret:", "MySecret"]],
  ["embedded secret label", ["tool", "--data=password:", "MySecret"]],
  ["--password", ["tool", "--password", "MySecret"]],
  ["--token", ["tool", "--token", "MySecret"]],
  ["--secret", ["tool", "--secret", "MySecret"]],
  ["Authorization header", ["curl", "-H", "Authorization: Bearer MySecret"]],
  [
    "Bearer header value",
    ["curl", "-H", "Authorization:", "Bearer", "MySecret"],
  ],
  ["standalone Bearer value", ["curl", "-H", "Bearer MySecret"]],
];

test.each(secretFlagCases)("redacts %s", (_label, argv) => {
  expect(redactCommandHistoryArgv(argv).join(" ")).not.toContain("MySecret");
});

test("URL userinfo preserves the username while hiding the password", () => {
  expect(
    redactCommandHistoryArgv(["https://admin:MySecret@example.test/path"]),
  ).toEqual(["https://admin:[REDACTED]@example.test/path"]);
});

test("serializes a started and outcome pair and retains stable sequences", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-command-history-"));
  try {
    const store = new CommandHistoryStore(join(dir, "inventory.yaml"), {
      getUid: nonRootUid,
      now: () => 1250,
      warn: () => {},
    });
    const runId = "run-1";
    await Promise.all([
      store.append(input("started", 1000, runId)),
      store.append(input("outcome", 1250, runId)),
    ]);
    const entries = await store.read();
    expect(entries.map(({ phase, sequence }) => [phase, sequence])).toEqual([
      ["started", 1],
      ["outcome", 2],
    ]);
    expect(entries[0]?.durationMs).toBeUndefined();
    expect(entries[1]?.durationMs).toBe(250);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotates by entry count and age", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "homectl-command-history-retention-"),
  );
  try {
    let now = 1_800_000_000_003;
    const store = new CommandHistoryStore(join(dir, "inventory.yaml"), {
      maxEntries: 3,
      maxAgeDays: 30,
      getUid: nonRootUid,
      now: () => now,
      warn: () => {},
    });
    const base = 1_800_000_000_000;
    for (let index = 0; index < 4; index++)
      await store.append({
        ...input("outcome", base + index, `count-${index}`),
        startedAt: undefined,
      });
    expect((await store.read()).map((entry) => entry.sequence)).toEqual([
      2, 3, 4,
    ]);

    now = base + 31 * 24 * 60 * 60 * 1000;
    await store.append({
      ...input("outcome", now, "after-age"),
      startedAt: undefined,
    });
    expect((await store.read()).map((entry) => entry.operationId)).toEqual([
      "after-age",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skips root-owned writes with a stderr warning and private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-command-history-owner-"));
  try {
    const warnings: string[] = [];
    const rootStore = new CommandHistoryStore(join(dir, "root.yaml"), {
      getUid: () => 0,
      warn: (message) => warnings.push(message),
    });
    await rootStore.append(input("outcome", 1000, "root-run"));
    expect(await rootStore.read()).toEqual([]);
    expect(warnings).toContain(
      "Local command history was not written because homectl is running as root.",
    );

    const store = new CommandHistoryStore(join(dir, "user.yaml"), {
      getUid: nonRootUid,
      warn: () => {},
    });
    await store.append(input("outcome", 1000, "user-run"));
    if (process.platform !== "win32")
      expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("history write failures warn without rejecting the command recorder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "homectl-command-history-failure-"));
  try {
    await writeFile(join(dir, "history"), "not a directory");
    const warnings: string[] = [];
    const store = new CommandHistoryStore(join(dir, "inventory.yaml"), {
      getUid: nonRootUid,
      warn: (message) => warnings.push(message),
    });
    await expect(
      store.append(input("outcome", Date.now(), "failed-write")),
    ).resolves.toBeUndefined();
    expect(warnings).toContain("Could not write local command history.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
