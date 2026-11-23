// The owner routes behind approved setup requests (0.3 acceptance). Each request
// kind maps to one owner route; enrolment carries the typed fingerprint; results
// and failures reach the agent as plain sentences with no address or key in them.
import { describe, expect, test } from "bun:test";
import { HomectlError } from "../src/types";
import { ownerSetupPort, type OwnerCall } from "../src/broker/setup-exec";
import type { SetupRun } from "../src/broker/types";

const ADDRESS = "192.0.2.77";
const FP = `SHA256:${"C".repeat(43)}`;

function recorder(replies: Record<string, unknown | Error>) {
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const call: OwnerCall = async (path, input) => {
    calls.push({ path, input });
    const reply = replies[path];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, call };
}

describe("approved setup requests reach the owner routes", () => {
  test("each kind calls its own route", async () => {
    const hosts = recorder({
      "/v1/owner/hosts/scan": {
        keys: [{ type: "ssh-ed25519", fingerprint: FP }],
      },
      "/v1/owner/hosts/probe": { ok: true, os: "Linux" },
      "/v1/owner/hosts/access": { name: "nas", access: "observe" },
      "/v1/owner/hosts/remove": { removed: true },
    });
    const policy = recorder({ "/v1/owner/policy/preset": { mode: "auto" } });
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: policy.call,
      settings: recorder({}).call,
    });

    const cases: SetupRun[] = [
      { kind: "scan", input: { address: ADDRESS, port: 22 } },
      { kind: "probe", input: { name: "nas" } },
      { kind: "access", input: { name: "nas", access: "observe" } },
      { kind: "remove", input: { name: "nas" } },
      { kind: "preset", input: { preset: "delegated" } },
    ];
    for (const request of cases) await port.run(request);
    expect(hosts.calls.map((call) => call.path)).toEqual([
      "/v1/owner/hosts/scan",
      "/v1/owner/hosts/probe",
      "/v1/owner/hosts/access",
      "/v1/owner/hosts/remove",
    ]);
    expect(policy.calls).toEqual([
      { path: "/v1/owner/policy/preset", input: { preset: "delegated" } },
    ]);
  });

  test("enrolment passes the typed fingerprint, never one the agent made up", async () => {
    const hosts = recorder({
      "/v1/owner/hosts/enroll": {
        name: "new-box",
        os: "Linux",
        access: "user",
      },
    });
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    const result = await port.run({
      kind: "enroll",
      input: { name: "new-box", address: ADDRESS, user: "ops", access: "user" },
      confirmFingerprint: FP,
    });
    expect(result.exitCode).toBe(0);
    expect(hosts.calls[0]?.input).toEqual({
      name: "new-box",
      address: ADDRESS,
      user: "ops",
      access: "user",
      fingerprint: FP,
    });
  });

  test("enrolment without the owner's confirmation runs nothing", async () => {
    const hosts = recorder({});
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    const result = await port.run({
      kind: "enroll",
      input: { name: "new-box", address: ADDRESS, user: "ops", access: "user" },
    });
    expect(result.exitCode).toBe(1);
    expect(hosts.calls).toEqual([]);
  });
});

describe("what the agent reads back", () => {
  test("a scan reports how many keys were found, not the keys", async () => {
    const hosts = recorder({
      "/v1/owner/hosts/scan": {
        address: ADDRESS,
        keys: [{ type: "ssh-ed25519", fingerprint: FP }],
      },
    });
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    const result = await port.run({
      kind: "scan",
      input: { address: ADDRESS, port: 22 },
    });
    expect(result.stdout).toBe(
      "Found 1 host key(s) at the address. Nothing was added or trusted.",
    );
    expect(result.stdout).not.toContain(ADDRESS);
    expect(result.stdout).not.toContain(FP);
  });

  test("a probe that fails says so without the probe's own text", async () => {
    const hosts = recorder({
      "/v1/owner/hosts/probe": {
        ok: false,
        reason: `ssh: connect to host ${ADDRESS} port 22: refused`,
      },
    });
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    const result = await port.run({ kind: "probe", input: { name: "nas" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "The machine did not answer the check. The owner can see why in Details.",
    );
    expect(result.stdout).not.toContain(ADDRESS);
  });

  test("a failing route reaches the agent with the address taken out", async () => {
    const hosts = recorder({
      "/v1/owner/hosts/enroll": new HomectlError(
        3,
        `Could not reach ${ADDRESS} to pin its key`,
      ),
    });
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    const result = await port.run({
      kind: "enroll",
      input: { name: "new-box", address: ADDRESS, user: "ops", access: "user" },
      confirmFingerprint: FP,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Could not reach that address to pin its key");
  });

  test("an unexpected failure gets one generic sentence", async () => {
    const hosts = recorder({
      "/v1/owner/hosts/remove": new Error(`disk full at /state/${ADDRESS}`),
    });
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    const result = await port.run({ kind: "remove", input: { name: "nas" } });
    expect(result.stderr).toBe(
      "The change did not finish. The owner can see why in Details.",
    );
  });

  test("presented keys are read through the scan route; a failed scan is one plain refusal", async () => {
    const good = recorder({
      "/v1/owner/hosts/scan": {
        keys: [{ type: "ssh-ed25519", fingerprint: FP }],
      },
    });
    const port = ownerSetupPort({
      hosts: good.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    expect(await port.presentedKeys(ADDRESS, 22)).toEqual([
      { type: "ssh-ed25519", fingerprint: FP },
    ]);

    const bad = recorder({
      "/v1/owner/hosts/scan": new Error(`no route to ${ADDRESS}`),
    });
    const refused = ownerSetupPort({
      hosts: bad.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    await expect(refused.presentedKeys(ADDRESS, 22)).rejects.toThrow(
      "did not present a host key",
    );
    const error = await refused.presentedKeys(ADDRESS, 22).catch((e) => e);
    expect(String(error.message)).not.toContain(ADDRESS);
  });

  test("the key-ready check reads the owner's key status", async () => {
    const hosts = recorder({
      "/v1/owner/hosts/key-status": { present: true },
    });
    const port = ownerSetupPort({
      hosts: hosts.call,
      policy: recorder({}).call,
      settings: recorder({}).call,
    });
    expect(await port.keyReady("new-box")).toBe(true);
    expect(hosts.calls[0]?.input).toEqual({ name: "new-box" });
  });
});
