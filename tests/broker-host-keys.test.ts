// Host key trust through the broker (homelab #21 H31/C1): a scan is shown as
// unverified, and only a key whose fingerprint the owner typed is pinned.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostKeyRoutes,
  keyFingerprint,
  parseKeyscan,
} from "../src/broker/host-keys";
import { HomectlError, type Machine, type ProcessSpec } from "../src/types";

const host = "lab";
const ED =
  "AAAAC3NzaC1lZDI1NTE5AAAAIBVnTGs5JuBXNWbmPAEQX0mCqMnIDoNtKLkV0w8ptQaH";
const RSA = "AAAAB3NzaC1yc2EAAAADAQABAAAAgQDF";
const OTHER =
  "AAAAC3NzaC1lZDI1NTE5AAAAIK0nWZHd7cUtOGkcPgmBrVwLDGP0wpZ7VYuBqqOrDsDf";
let dir: string;
let presented: string;
let calls: ProcessSpec[];
let audit: unknown[];
const machine: Machine = {
  description: "Synthetic host",
  transport: "ssh",
  access: "observe",
  address: "192.0.2.10",
  user: "operator",
  port: 2222,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-host-keys-"));
  presented = `# 192.0.2.10:2222 SSH-2.0-OpenSSH_9.6\n[192.0.2.10]:2222 ssh-ed25519 ${ED}\n[192.0.2.10]:2222 ssh-rsa ${RSA}\n`;
  calls = [];
  audit = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const routes = () =>
  new HostKeyRoutes(
    {
      machine: async (id) => (id === host ? machine : undefined),
      hosts: async () => [host],
    },
    join(dir, "inventory.yaml"),
    async (spec) => {
      calls.push(spec);
      return { exitCode: 0, stdout: presented, stderr: "" };
    },
    { emit: async (_type, _subject, _audience, data) => void audit.push(data) },
  );
const stepUp = async (password: unknown) => {
  if (password !== "fixture") throw new HomectlError(3, "Wrong owner password");
};
const call = (path: string, extra: Record<string, unknown> = {}) =>
  routes().owner(
    `/v1/owner/hosts/${path}`,
    { host, password: "fixture", ...extra },
    stepUp,
  ) as Promise<Record<string, unknown>>;
const knownHosts = () =>
  readFile(join(dir, "known_hosts"), "utf8").catch(() => "");

test("parses keyscan output and fingerprints like ssh-keygen", () => {
  expect(parseKeyscan(presented).map((k) => k.type)).toEqual([
    "ssh-ed25519",
    "ssh-rsa",
  ]);
  expect(keyFingerprint(ED)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("a scan is unverified and changes nothing", async () => {
  const scan = await call("scan-keys");
  expect(scan).toMatchObject({
    host,
    address: "[192.0.2.10]:2222",
    trusted: false,
    keys: [
      { type: "ssh-ed25519", fingerprint: keyFingerprint(ED), pinned: false },
      { type: "ssh-rsa", pinned: false },
    ],
  });
  expect(calls[0]?.argv.slice(1)).toEqual([
    "-T",
    "5",
    "-p",
    "2222",
    "--",
    "192.0.2.10",
  ]);
  expect(await knownHosts()).toBe("");
});

test("pins only the key with the owner-verified fingerprint", async () => {
  await writeFile(join(dir, "known_hosts"), "other.example ssh-ed25519 AAAA");
  await expect(
    call("pin-key", { fingerprint: keyFingerprint(OTHER) }),
  ).rejects.toThrow("No key with that fingerprint");
  await expect(call("pin-key", { fingerprint: "ab:cd" })).rejects.toThrow(
    "SHA256",
  );
  const pinned = await call("pin-key", { fingerprint: keyFingerprint(ED) });
  expect(pinned).toMatchObject({ changed: true });
  expect(await knownHosts()).toBe(
    `other.example ssh-ed25519 AAAA\n[192.0.2.10]:2222 ssh-ed25519 ${ED}\n`,
  );
  // Idempotent, and the scan now reports it as pinned.
  expect(
    await call("pin-key", { fingerprint: keyFingerprint(ED) }),
  ).toMatchObject({ changed: false });
  const scan = await call("scan-keys");
  expect((scan.keys as { pinned: boolean }[])[0]?.pinned).toBe(true);
  expect(audit).toEqual([
    {
      action: "pin-host-key",
      status: "pinned",
      fingerprint: keyFingerprint(ED),
    },
    {
      action: "pin-host-key",
      status: "unchanged",
      fingerprint: keyFingerprint(ED),
    },
  ]);
});

test("refuses replacing an existing pin, revoked keys and a wrong password", async () => {
  await expect(
    call("pin-key", { fingerprint: keyFingerprint(ED), password: "nope" }),
  ).rejects.toThrow("Wrong owner password");
  expect(calls).toHaveLength(0);
  await writeFile(
    join(dir, "known_hosts"),
    `[192.0.2.10]:2222 ssh-ed25519 ${OTHER}\n`,
  );
  await expect(
    call("pin-key", { fingerprint: keyFingerprint(ED) }),
  ).rejects.toThrow("different key is already pinned");
  await writeFile(join(dir, "known_hosts"), `@revoked * ssh-ed25519 ${ED}\n`);
  await expect(
    call("pin-key", { fingerprint: keyFingerprint(ED) }),
  ).rejects.toThrow("revoked");
  expect(await knownHosts()).toBe(`@revoked * ssh-ed25519 ${ED}\n`);
  presented = "";
  await expect(call("scan-keys")).rejects.toThrow("presented no SSH keys");
});
