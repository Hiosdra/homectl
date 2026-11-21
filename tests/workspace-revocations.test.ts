// Revocations reapplied to a restore (homelab #21 §6): a revoked host key does
// not come back through a restored known_hosts, and a policy rule removed since
// the snapshot does not come back through a restored policy. Only what the
// client last reported is known; the restore says so.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRevocations,
  policyRuleIds,
  readRevocations,
  revokedKeys,
} from "../src/workspace/revocations";
import {
  clientId,
  fixture,
  type Harness,
  link,
  OWNER_PASSWORD,
  SERVER_ADDRESS,
  stepUp,
} from "./workspace-helpers";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => Buffer.from(data).toString("utf8");

const KNOWN_HOSTS =
  "lab ssh-ed25519 AAAAK1\nlab ssh-ed25519 AAAAK2\n@cert-authority * ssh-rsa AAAACA\n";
const POLICY = JSON.stringify({
  version: 1,
  rules: [{ id: "rule-keep" }, { id: "rule-old" }],
});

let h: Harness;

beforeEach(async () => {
  h = await fixture();
});
afterEach(async () => {
  await h.cleanup();
});

test("revoked host keys are read from @revoked lines only", () => {
  const found = revokedKeys(
    [
      "lab ssh-ed25519 AAAAK1",
      "@revoked * ssh-ed25519 AAAAK2 comment",
      "@revoked lab ssh-rsa AAAAK3",
      "@revoked * ssh-ed25519 not*base64",
      "",
    ].join("\n"),
  );
  expect(found).toEqual([
    { type: "ssh-ed25519", blob: "AAAAK2" },
    { type: "ssh-rsa", blob: "AAAAK3" },
  ]);
});

test("policy rule ids are read from a policy; an unreadable policy reports none", () => {
  expect(policyRuleIds(POLICY)).toEqual(["rule-keep", "rule-old"]);
  expect(policyRuleIds(undefined)).toBeUndefined();
  expect(policyRuleIds("not json")).toBeUndefined();
  expect(policyRuleIds('{"rules":"nope"}')).toBeUndefined();
});

test("readRevocations treats a missing known_hosts as no revoked keys and a missing policy as unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc-revocations-"));
  try {
    const empty = await readRevocations(
      join(dir, "known_hosts"),
      join(dir, "policy.json"),
    );
    expect(empty).toEqual({ hostKeys: [] });
    await writeFile(
      join(dir, "known_hosts"),
      "@revoked * ssh-ed25519 AAAAK2\n",
    );
    await writeFile(join(dir, "policy.json"), POLICY);
    expect(
      await readRevocations(join(dir, "known_hosts"), join(dir, "policy.json")),
    ).toEqual({
      hostKeys: [{ type: "ssh-ed25519", blob: "AAAAK2" }],
      policyRules: ["rule-keep", "rule-old"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a revoked key is dropped from a restored known_hosts and marked revoked", () => {
  const files = [{ path: "known_hosts", data: bytes(KNOWN_HOSTS) }];
  const applied = applyRevocations(
    files,
    {
      at: 10,
      hostKeys: [{ type: "ssh-ed25519", blob: "AAAAK2" }],
      policyRules: [],
    },
    5,
  );
  const restored = text(applied.files[0]?.data ?? new Uint8Array());
  const pinned = restored
    .split("\n")
    .filter((line) => line && !line.startsWith("@"));
  expect(pinned).toEqual(["lab ssh-ed25519 AAAAK1"]);
  expect(restored).toContain("@cert-authority * ssh-rsa AAAACA");
  expect(restored).toContain("@revoked * ssh-ed25519 AAAAK2");
  expect(applied.notes).toContain(
    "known_hosts: 1 revoked key(s) removed, 1 revocation marker(s) added.",
  );
});

test("a rule removed since the snapshot is dropped only when the report is not older than it", () => {
  const files = [{ path: "policy.json", data: bytes(POLICY) }];
  const newer = applyRevocations(
    files,
    { at: 20, hostKeys: [], policyRules: ["rule-keep"] },
    10,
  );
  expect(
    JSON.parse(text(newer.files[0]?.data ?? new Uint8Array())).rules,
  ).toEqual([{ id: "rule-keep" }]);
  expect(newer.notes).toContain(
    "policy.json: 1 rule(s) revoked since the snapshot were removed.",
  );

  // A report older than the snapshot cannot say whether a rule was added after
  // it or removed after it, so no rule is dropped and the restore says so.
  const older = applyRevocations(
    files,
    { at: 5, hostKeys: [], policyRules: ["rule-keep"] },
    10,
  );
  expect(text(older.files[0]?.data ?? new Uint8Array())).toBe(POLICY);
  expect(older.notes.join("\n")).toContain("predates the snapshot");
});

test("without a report nothing is reapplied, and the restore says so", () => {
  const files = [
    { path: "known_hosts", data: bytes(KNOWN_HOSTS) },
    { path: "policy.json", data: bytes(POLICY) },
  ];
  const applied = applyRevocations(files, undefined, 1);
  expect(applied.files).toEqual(files);
  expect(applied.notes[0]).toContain("reported no revocations");
});

test("a restore reapplies the revocations the source reported at its last sync", async () => {
  h.revocations = {
    hostKeys: [{ type: "ssh-ed25519", blob: "AAAAK2" }],
    policyRules: ["rule-keep"],
  };
  await link(h);
  const id = await clientId(h);
  h.files = [
    { path: "inventory.yaml", data: bytes("hosts: {}\n") },
    { path: "known_hosts", data: bytes(KNOWN_HOSTS) },
    { path: "policy.json", data: bytes(POLICY) },
  ];
  await h.client.backupOnce();
  // The report is sent after the snapshot, so it is at or after it.
  await h.client.syncOnce();

  const issued = (await h.server.owner(
    "/v1/owner/workspace/restore",
    { client: id, seq: 1, reason: "laptop reset", password: OWNER_PASSWORD },
    stepUp,
  )) as { code: string };
  const device = await h.freshDevice("revoked-restore");
  const joined = (await device.client.owner(
    "/v1/owner/workspace/join",
    {
      address: SERVER_ADDRESS,
      code: issued.code,
      remoteApproval: false,
      password: OWNER_PASSWORD,
    },
    stepUp,
  )) as { restore: { status: string; notes: string[] } };

  expect(joined.restore.status).toBe("restored");
  expect(joined.restore.notes).toContain(
    "known_hosts: 1 revoked key(s) removed, 1 revocation marker(s) added.",
  );
  expect(joined.restore.notes).toContain(
    "policy.json: 1 rule(s) revoked since the snapshot were removed.",
  );
  const restoredHosts = text(
    device.restore.written.get("known_hosts") ?? new Uint8Array(),
  );
  expect(
    restoredHosts.split("\n").filter((line) => line && !line.startsWith("@")),
  ).toEqual(["lab ssh-ed25519 AAAAK1"]);
  const restoredPolicy = JSON.parse(
    text(device.restore.written.get("policy.json") ?? new Uint8Array()),
  ) as { rules: { id: string }[] };
  expect(restoredPolicy.rules.map((rule) => rule.id)).toEqual(["rule-keep"]);
  // Stored as the snapshot had it: the inventory is never rewritten.
  expect(
    text(device.restore.written.get("inventory.yaml") ?? new Uint8Array()),
  ).toBe("hosts: {}\n");
  expect(
    await readFile(join(h.serverDir, "workspace-audit.jsonl"), "utf8"),
  ).not.toContain("AAAAK2");
});
