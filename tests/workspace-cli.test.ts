// Owner workspace commands (homelab #21 §6): argument checks, and the output
// the owner reads for clients, pending operations, joins and retired clients.
// The broker is replaced by a fake caller, so no daemon runs.
import { expect, test } from "bun:test";
import {
  type BrokerCall,
  type OwnerAuth,
  workspaceCommand,
} from "../src/cli/workspace-commands";
import { HomectlError } from "../src/types";

interface Recorded {
  path: string;
  body: Record<string, unknown>;
}

function fake(answers: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const lines: string[] = [];
  const call: BrokerCall = async <T>(
    path: string,
    body: Record<string, unknown>,
  ) => {
    calls.push({ path, body });
    if (!Object.hasOwn(answers, path))
      throw new Error(`no fake answer for ${path}`);
    return answers[path] as T;
  };
  const auth = async (): Promise<OwnerAuth> => ({
    endpoint: {} as OwnerAuth["endpoint"],
    authorization: "Owner test",
    password: "owner-pass",
  });
  const run = (positionals: string[], reason?: string) =>
    workspaceCommand(positionals, {
      auth,
      emit: (_value, human) => {
        lines.push(human ?? "");
      },
      remoteApproval: false,
      ...(reason === undefined ? {} : { reason }),
      call,
    });
  return { calls, lines, run };
}

async function refusal(run: () => Promise<number>): Promise<HomectlError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HomectlError) return error;
    throw error;
  }
  throw new Error("expected the command to be refused");
}

test("restore-preview is refused without --reason, and the broker is never called", async () => {
  const { calls, run } = fake();
  const error = await refusal(() => run(["restore-preview", "laptop"]));
  expect(error.code).toBe(2);
  expect(error.message).toContain("--reason is required");
  expect(calls).toHaveLength(0);
});

test("restore is refused without --reason or with a blank one", async () => {
  const { calls, run } = fake();
  const missing = await refusal(() => run(["restore", "laptop", "3"]));
  expect(missing.code).toBe(2);
  const blank = await refusal(() => run(["restore", "laptop", "3"], "   "));
  expect(blank.code).toBe(2);
  expect(calls).toHaveLength(0);
});

test("restore needs a whole-number sequence", async () => {
  const { calls, run } = fake();
  const error = await refusal(() => run(["restore", "laptop", "three"], "why"));
  expect(error.code).toBe(2);
  expect(error.message).toContain("Usage: home-ctl workspace restore");
  expect(calls).toHaveLength(0);
});

test("restore sends the reason and the owner password, and prints the join code", async () => {
  const { calls, lines, run } = fake({
    "/v1/owner/workspace/restore": {
      code: "482913",
      expiresAt: "2026-11-20T10:05:00.000Z",
      restore: { source: "c-1", seq: 3, files: 3, bytes: 120 },
    },
  });
  expect(await run(["restore", "laptop", "3"], "  laptop reset  ")).toBe(0);
  expect(calls[0]?.body).toEqual({
    client: "laptop",
    seq: 3,
    reason: "laptop reset",
    password: "owner-pass",
  });
  const text = lines.join("\n");
  expect(text).toContain(
    "Restoring snapshot 3 of laptop (3 file(s), 120 bytes)",
  );
  expect(text).toContain("join <server> 482913");
  expect(text).toContain("reapplied");
});

test("clients print lag, quota and retention for each linked client", async () => {
  const { lines, run } = fake({
    "/v1/owner/workspace/clients": [
      {
        id: "a1",
        name: "laptop",
        stale: true,
        remoteApproval: true,
        pending: 2,
        backupRequested: false,
        backup: {
          latestSeq: 5,
          latestAt: Date.parse("2026-11-20T10:00:00.000Z"),
          clientSeq: 7,
          lagSnapshots: 2,
          lagSeconds: 120,
          clientLastError: "Backup storage quota reached",
          snapshots: 5,
          storedBytes: 4096,
          quota: { usedBytes: 500, limitBytes: 1073741824 },
          retention: { oldestAt: null, scheduled: false },
        },
      },
    ],
  });
  expect(await run(["clients"])).toBe(0);
  const text = lines.join("\n");
  expect(text).toContain("laptop  (stale)  remote approval: on  pending: 2");
  expect(text).toContain("latest seq 5");
  expect(text).toContain("lag 2 snapshot(s), 120 s since last recoverable");
  expect(text).toContain(
    "storage: 4096 bytes stored in 5 snapshot(s); quota 500 of 1073741824 bytes",
  );
  expect(text).toContain("no automatic pruning yet, history is kept");
  expect(text).toContain("last backup error: Backup storage quota reached");
});

test("clients say so when there are none", async () => {
  const { lines, run } = fake({ "/v1/owner/workspace/clients": [] });
  await run(["clients"]);
  expect(lines).toEqual(["No linked clients."]);
});

test("pending prints the impact line under each operation", async () => {
  const { lines, run } = fake({
    "/v1/owner/workspace/pending": [
      {
        origin: "a1",
        originName: "laptop",
        id: "op-9",
        host: "lab",
        argv: ["systemctl", "restart", "nginx"],
        fingerprint: "fp-9",
        risk: "medium",
        impact: "Changes state on lab: systemctl restart nginx with sudo",
      },
    ],
  });
  expect(await run(["pending"])).toBe(0);
  const text = lines.join("\n");
  expect(text).toContain("op-9  laptop -> lab  [medium]  fingerprint fp-9");
  expect(text).toContain(
    "    Changes state on lab: systemctl restart nginx with sudo",
  );
  expect(text).toContain('["systemctl","restart","nginx"]');
});

test("pending shows the status of the decision queued for each operation", async () => {
  const { lines, run } = fake({
    "/v1/owner/workspace/pending": [
      {
        origin: "a1",
        originName: "laptop",
        id: "op-9",
        host: "lab",
        argv: ["systemctl", "restart", "nginx"],
        fingerprint: "fp-9",
        risk: "medium",
        impact: "Changes state on lab",
        intent: null,
      },
      {
        origin: "a1",
        originName: "laptop",
        id: "op-10",
        host: "lab",
        argv: ["uptime"],
        fingerprint: "fp-10",
        risk: "low",
        impact: "Reads state on lab",
        intent: {
          id: "i-1",
          decision: "approve-once",
          status: "refused",
          reason: "expired",
          expiresAt: 1_800_000_000_000,
        },
      },
    ],
  });
  expect(await run(["pending"])).toBe(0);
  const text = lines.join("\n");
  expect(text).toContain("no decision queued");
  expect(text).toContain("decision refused (approve-once: expired)");
});

test("intents lists the decisions queued for clients, scoped when a client is named", async () => {
  const row = {
    id: "i-1",
    operationId: "op-9",
    client: "a1",
    decision: "approve-once",
    status: "delivered",
    expiresAt: 1_800_000_000_000,
  };
  const { calls, lines, run } = fake({
    "/v1/owner/workspace/intents": { intents: [row] },
  });
  expect(await run(["intents"])).toBe(0);
  expect(calls[0]?.path).toBe("/v1/owner/workspace/intents");
  expect(calls[0]?.body).toEqual({});
  expect(lines.join("\n")).toContain(
    `i-1  a1  op-9  delivered (approve-once)  expires ${new Date(1_800_000_000_000).toISOString()}`,
  );

  const scoped = fake({ "/v1/owner/workspace/intents": { intents: [] } });
  expect(await scoped.run(["intents", "a1"])).toBe(0);
  expect(scoped.calls[0]?.body).toEqual({ client: "a1" });
  expect(scoped.lines.join("\n")).toContain("No decisions have been queued");
});

test("join reports a refused restore with its reason", async () => {
  const { lines, run } = fake({
    "/v1/owner/workspace/join": {
      server: { id: "s", name: "server" },
      sas: "alpha bravo",
      backupKey: "registered",
      restore: {
        status: "refused",
        reason:
          "inventory.yaml already exists on this device, so the restore was not applied.",
      },
    },
  });
  expect(await run(["join", "server.lan:7450", "482913"])).toBe(0);
  const text = lines.join("\n");
  expect(text).toContain("Verification phrase: alpha bravo");
  expect(text).toContain(
    "Restore not applied: inventory.yaml already exists on this device",
  );
});

test("join says when a restored device is not yet acknowledged, and lists what was reapplied", async () => {
  const { lines, run } = fake({
    "/v1/owner/workspace/join": {
      server: { id: "s", name: "server" },
      sas: "alpha bravo",
      backupKey: "registered",
      restore: {
        status: "restored",
        seq: 4,
        files: ["inventory.yaml", "known_hosts"],
        acknowledged: false,
        notes: [
          "known_hosts: 1 revoked key(s) removed, 0 revocation marker(s) added.",
        ],
      },
    },
  });
  await run(["join", "server.lan:7450", "482913"]);
  const text = lines.join("\n");
  expect(text).toContain("Restored snapshot 4: inventory.yaml, known_hosts.");
  expect(text).toContain("has not confirmed the restore yet");
  expect(text).toContain("known_hosts: 1 revoked key(s) removed");
});

test("retired lists each retired client, and one client shows its history", async () => {
  const row = {
    id: "old-1",
    name: "laptop",
    platform: "linux",
    cause: "restore",
    joinedAt: 0,
    retiredAt: Date.parse("2026-11-20T09:00:00.000Z"),
    restorable: true,
    historyKept: true,
    mirror: { lastSeq: 12, gaps: 1, events: 12 },
    pending: 0,
  };
  const listing = fake({ "/v1/owner/workspace/retired": [row] });
  expect(await listing.run(["retired"])).toBe(0);
  const text = listing.lines.join("\n");
  expect(text).toContain("old-1  laptop  restore at 2026-11-20T09:00:00.000Z");
  expect(text).toContain("12 mirrored event(s), last seq 12, 1 gap(s)");
  expect(text).toContain("history kept");
  expect(text).toContain("backups restorable");
  expect(listing.calls[0]?.body).toEqual({});

  const history = fake({
    "/v1/owner/workspace/retired": { row, events: [], pending: [] },
  });
  await history.run(["retired", "old-1"]);
  expect(history.calls[0]?.body).toEqual({ client: "old-1" });
});

test("retired says so when nothing has retired", async () => {
  const { lines, run } = fake({ "/v1/owner/workspace/retired": [] });
  await run(["retired"]);
  expect(lines).toEqual(["No retired clients."]);
});
