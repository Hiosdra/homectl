// Owner-panel machines (0.3 guided setup, part 2). The routes need the owner
// session and step-up; enrolment pins only the fingerprint the owner typed; a
// scan pins nothing; a failed enrolment leaves no trust behind; removal and the
// access level are checked; the list never shows key material. Every ssh and
// keyscan call goes to a stub runner: no machine is contacted.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientView } from "../src/control/types";
import { keyFingerprint } from "../src/broker/host-keys";
import { OwnerSessions } from "../src/broker/owner";
import { OwnerHostRoutes } from "../src/broker/owner-hosts";
import type { Broker } from "../src/broker/engine";
import { handler } from "../src/broker/server";
import { parseInventory } from "../src/inventory";
import { sessionPaths } from "../src/session";
import {
  HomectlError,
  type ProcessResult,
  type ProcessSpec,
} from "../src/types";

// Two real ed25519 public blobs (51 bytes each), so the key checks accept them.
const ED =
  "AAAAC3NzaC1lZDI1NTE5AAAAIBVnTGs5JuBXNWbmPAEQX0mCqMnIDoNtKLkV0w8ptQaH";
const OTHER =
  "AAAAC3NzaC1lZDI1NTE5AAAAIK0nWZHd7cUtOGkcPgmBrVwLDGP0wpZ7VYuBqqOrDsDf";
const ED_FP = keyFingerprint(ED);
const OTHER_FP = keyFingerprint(OTHER);
// Documentation addresses (RFC 5737): nothing here reaches a real host.
const NEW_ADDRESS = "192.0.2.10";
const NAS_ADDRESS = "192.0.2.20";
const PASSWORD = "owner test password";
const ORIGIN = "http://127.0.0.1:7451";
const NOW = Date.UTC(2026, 10, 21, 9, 0, 0);

let dir: string;
let inventoryPath: string;
let knownHostsPath: string;
let keysDir: string;
let calls: ProcessSpec[];
let presented: string;
const keyscanLine = (line: string) => `# host
${line}
`;
let probeResult: ProcessResult;
let clientRows: ClientView[];

// Every ssh machine carries its managed key (the schema requires it). Paths are
// quoted JSON strings, so Windows paths survive the YAML.
function inventoryFor(): string {
  const socket = sessionPaths(inventoryPath).socket;
  const auth = (entry: string, name: string) => `    auth:
      type: keepassxc
      entry: ${JSON.stringify(entry)}
      socket: ${JSON.stringify(socket)}
      public_key: ${JSON.stringify(join(keysDir, `${name}.pub`))}
`;
  return `version: 1
session:
  ttl: 24h
  database: ${JSON.stringify(join(dir, "homelab.kdbx"))}
machines:
  nas:
    description: Test NAS
    transport: ssh
    ssh_alias: nas
    address: ${NAS_ADDRESS}
    user: operator
    access: user
${auth("homectl-nas", "nas")}  root-box:
    description: Test root machine
    transport: ssh
    ssh_alias: root-box
    address: 192.0.2.21
    user: root
    access: full
${auth("homectl-root-box", "root-box")}`;
}
let INVENTORY = "";

const stepUp = async (password: unknown) => {
  if (password !== PASSWORD)
    throw new HomectlError(3, "Confirm with the owner password");
};
const runner = async (spec: ProcessSpec): Promise<ProcessResult> => {
  calls.push(spec);
  if (spec.argv.some((arg) => arg.includes("ssh-keyscan")))
    return { exitCode: 0, stdout: presented, stderr: "" };
  return probeResult;
};
const ok = (stdout = "Linux\n"): ProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
const fails = (stderr: string): ProcessResult => ({
  exitCode: 255,
  stdout: "",
  stderr,
});

function routes(): OwnerHostRoutes {
  return new OwnerHostRoutes({
    inventoryPath,
    configPath: join(dir, "ssh_config"),
    state: dir,
    clients: {
      list: async () => clientRows,
      dropHost: async (host) => {
        let changed = 0;
        for (const row of clientRows)
          if (row.hosts.includes(host)) {
            row.hosts = row.hosts.filter((item) => item !== host);
            changed += 1;
          }
        return changed;
      },
    },
    runner,
    now: () => NOW,
  });
}

// The owner's own call, through the same routes the broker mounts.
const call = (path: string, input: Record<string, unknown> = {}) =>
  routes().owner(`/v1/owner/hosts/${path}`, input, stepUp) as Promise<
    Record<string, unknown>
  >;
// GET /v1/owner/hosts, the list.
const listing = () =>
  routes().owner("/v1/owner/hosts", {}, stepUp) as Promise<{
    machines: Record<string, unknown>[];
  }>;
const enrollInput = (extra: Record<string, unknown> = {}) => ({
  password: PASSWORD,
  name: "box",
  address: NEW_ADDRESS,
  user: "operator",
  access: "observe",
  fingerprint: ED_FP,
  ...extra,
});
const inventoryText = () => readFile(inventoryPath, "utf8");
const knownHosts = () => readFile(knownHostsPath, "utf8").catch(() => "");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-owner-hosts-"));
  inventoryPath = join(dir, "inventory.yaml");
  knownHostsPath = join(dir, "known_hosts");
  keysDir = sessionPaths(inventoryPath).keys;
  await mkdir(keysDir, { recursive: true });
  // What `home-ctl key create nas` leaves behind: the public half only.
  await writeFile(join(keysDir, "nas.pub"), `ssh-ed25519 ${ED}\n`);
  // The new machine's key, made the same way before the owner enrols it.
  await writeFile(join(keysDir, "box.pub"), `ssh-ed25519 ${ED}\n`);
  INVENTORY = inventoryFor();
  await writeFile(inventoryPath, INVENTORY);
  calls = [];
  presented = keyscanLine(`${NEW_ADDRESS} ssh-ed25519 ${ED}`);
  probeResult = ok();
  clientRows = [
    {
      id: "claude",
      name: "Claude",
      scopes: [],
      hosts: ["nas", "root-box"],
      createdAt: "2026-11-01T00:00:00Z",
      revoked: false,
      hasToken: true,
    },
  ];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the list shows machines, access and identity, and no key material", async () => {
  // A private key file next to the public one must never reach the panel.
  await writeFile(
    join(keysDir, "nas"),
    "-----BEGIN OPENSSH PRIVATE KEY-----\n",
  );
  const list = (await listing()) as {
    machines: Record<string, unknown>[];
  };
  const text = JSON.stringify(list);
  expect(text).not.toContain("PRIVATE KEY");
  expect(text).not.toContain(dir);
  expect(list.machines.map((machine) => machine.name)).toEqual([
    "nas",
    "root-box",
  ]);
  expect(list.machines[0]).toMatchObject({
    name: "nas",
    address: NAS_ADDRESS,
    user: "operator",
    access: "user",
    pinned: null,
    probe: null,
    assistants: [{ id: "claude", name: "Claude" }],
  });
});

test("key status returns the public key and nothing else", async () => {
  expect(await call("key-status", { name: "nas" })).toEqual({
    name: "nas",
    present: true,
    publicKey: `ssh-ed25519 ${ED}`,
    fingerprint: ED_FP,
  });
  expect(await call("key-status", { name: "printer" })).toEqual({
    name: "printer",
    present: false,
  });
  await expect(call("key-status", { name: "Bad Name" })).rejects.toThrow(
    "lowercase letters",
  );
});

test("a scan is unverified and pins nothing", async () => {
  const scan = await call("scan", {
    password: PASSWORD,
    address: NEW_ADDRESS,
  });
  expect(scan).toMatchObject({
    address: NEW_ADDRESS,
    trusted: false,
    keys: [{ type: "ssh-ed25519", fingerprint: ED_FP, pinned: false }],
  });
  // The scan reports fingerprints only, never the key blob itself.
  expect(JSON.stringify(scan)).not.toContain(ED);
  expect(await knownHosts()).toBe("");
});

test("enrolment refuses anything but the exact typed fingerprint", async () => {
  const before = await inventoryText();
  await expect(
    call("enroll", enrollInput({ fingerprint: OTHER_FP })),
  ).rejects.toThrow("No key with that fingerprint");
  await expect(
    call("enroll", enrollInput({ fingerprint: "SHA256:short" })),
  ).rejects.toThrow("exactly as the machine shows it");
  // The password is asked first: a wrong one runs nothing and changes nothing.
  calls.length = 0;
  await expect(
    call("enroll", enrollInput({ password: "wrong" })),
  ).rejects.toThrow("Confirm with the owner password");
  expect(calls).toHaveLength(0);
  expect(await inventoryText()).toBe(before);
  expect(await knownHosts()).toBe("");
});

test("enrolment pins the typed fingerprint, writes the inventory and probes", async () => {
  const result = await call("enroll", enrollInput());
  expect(result).toEqual({
    name: "box",
    os: "Linux",
    pinned: ED_FP,
    access: "observe",
  });
  expect(await knownHosts()).toBe(`${NEW_ADDRESS} ssh-ed25519 ${ED}\n`);
  const inventory = parseInventory(await inventoryText());
  expect(inventory.machines.box).toMatchObject({
    transport: "ssh",
    ssh_alias: "box",
    address: NEW_ADDRESS,
    user: "operator",
    access: "observe",
    auth: { type: "keepassxc", entry: "homectl-box" },
  });
  const list = (await listing()) as {
    machines: { name: string; pinned: string; probe: { ok: boolean } }[];
  };
  expect(list.machines.find((m) => m.name === "box")).toMatchObject({
    pinned: ED_FP,
    probe: { ok: true, os: "Linux" },
  });
});

test("a machine whose probe fails after pinning is not left trusted", async () => {
  probeResult = fails(
    "ssh: connect to host 192.0.2.10 port 22: Connection timed out",
  );
  const before = await inventoryText();
  await expect(call("enroll", enrollInput())).rejects.toThrow(
    "could not be reached",
  );
  expect(await knownHosts()).toBe("");
  expect(await inventoryText()).toBe(before);
});

test("enrolment refuses a second pin for an address and a revoked key", async () => {
  await writeFile(knownHostsPath, `${NEW_ADDRESS} ssh-ed25519 ${OTHER}\n`);
  await expect(call("enroll", enrollInput())).rejects.toThrow(
    "different key is already pinned",
  );
  await writeFile(knownHostsPath, `@revoked * ssh-ed25519 ${ED}\n`);
  await expect(call("enroll", enrollInput())).rejects.toThrow("revoked");
});

test("enrolment checks the access rules: root is full, admin needs commands", async () => {
  await expect(
    call("enroll", enrollInput({ user: "root", access: "user" })),
  ).rejects.toThrow("always has full access");
  await expect(
    call("enroll", enrollInput({ access: "sudo-approved" })),
  ).rejects.toThrow("at least one allowed command");
  await expect(call("enroll", enrollInput({ name: "nas" }))).rejects.toThrow(
    "already in your list",
  );
  await expect(
    call(
      "enroll",
      enrollInput({
        name: "lamp",
        access: "observe",
        sudo_allow: [["/bin/ls"]],
      }),
    ),
  ).rejects.toThrow("apply only to Admin with your approval");
});

test("enrolment without a key in the vault says how to make it", async () => {
  await expect(
    call("enroll", enrollInput({ name: "printer" })),
  ).rejects.toThrow("home-ctl key create printer");
});

test("plain errors for an unreachable host, a wrong login, a changed host key", async () => {
  const cases: [string, RegExp][] = [
    [
      "ssh: connect to host 192.0.2.20 port 22: Connection timed out",
      /could not be reached/,
    ],
    [
      "Permission denied (publickey).",
      /login name is wrong, or the public key is not installed/,
    ],
    [
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED @@@\nHost key verification failed.",
      /SSH rejected the host key/,
    ],
  ];
  for (const [stderr, pattern] of cases) {
    probeResult = fails(stderr);
    const result = await call("probe", { name: "nas", password: PASSWORD });
    expect(result).toMatchObject({ name: "nas", ok: false });
    expect(String(result.reason)).toMatch(pattern);
  }
  // A failed check is recorded, and the list shows it as the last attempt.
  const list = (await listing()) as {
    machines: { name: string; probe: { ok: boolean; reason: string } }[];
  };
  expect(list.machines[0]?.probe).toMatchObject({ ok: false });
});

test("probes and the access level need the password, root stays full, sudo needs commands", async () => {
  expect(await call("probe", { name: "nas", password: PASSWORD })).toEqual({
    name: "nas",
    ok: true,
    os: "Linux",
    checkedAt: NOW,
  });
  await expect(
    call("probe", { name: "nas", password: "wrong" }),
  ).rejects.toThrow("Confirm with the owner password");
  await expect(
    call("access", { name: "nas", access: "full", password: "wrong" }),
  ).rejects.toThrow("Confirm with the owner password");
  await expect(
    call("access", { name: "root-box", access: "user", password: PASSWORD }),
  ).rejects.toThrow("always has full access");
  await expect(
    call("access", {
      name: "nas",
      access: "sudo-approved",
      password: PASSWORD,
    }),
  ).rejects.toThrow("at least one allowed command");
  expect(await inventoryText()).toBe(INVENTORY);

  expect(
    await call("access", { name: "nas", access: "full", password: PASSWORD }),
  ).toEqual({ name: "nas", access: "full" });
  expect(parseInventory(await inventoryText()).machines.nas?.access).toBe(
    "full",
  );
  expect(
    await call("access", {
      name: "nas",
      access: "sudo-approved",
      sudo_allow: [["/usr/bin/systemctl", "restart", "klipper"]],
      password: PASSWORD,
    }),
  ).toEqual({ name: "nas", access: "sudo-approved" });
  expect(parseInventory(await inventoryText()).machines.nas).toMatchObject({
    access: "sudo-approved",
    sudo_allow: [["/usr/bin/systemctl", "restart", "klipper"]],
  });
});

test("removing a machine needs the password and says what it leaves behind", async () => {
  await writeFile(
    knownHostsPath,
    `${NAS_ADDRESS} ssh-ed25519 ${ED}\n@revoked * ssh-ed25519 ${OTHER}\n`,
  );
  await expect(
    call("remove", { name: "nas", password: "wrong" }),
  ).rejects.toThrow("Confirm with the owner password");
  expect(parseInventory(await inventoryText()).machines.nas).toBeDefined();

  const removed = await call("remove", { name: "nas", password: PASSWORD });
  expect(removed).toEqual({
    name: "nas",
    removed: true,
    assistantsUpdated: 1,
    pinRemoved: true,
  });
  expect(parseInventory(await inventoryText()).machines.nas).toBeUndefined();
  expect(clientRows[0]?.hosts).toEqual(["root-box"]);
  expect(await knownHosts()).toBe(`@revoked * ssh-ed25519 ${OTHER}\n`);
  const ssh = await readFile(join(dir, "ssh_config"), "utf8");
  expect(ssh).not.toContain("Host nas");
  // The vault key and the public key file are not deleted.
  expect(await readFile(join(keysDir, "nas.pub"), "utf8")).toContain(ED);
});

test("the owner routes need a session, the Origin and the password", async () => {
  const owner = new OwnerSessions({
    verify: async (secret) => secret === PASSWORD,
  });
  const fetch = handler({
    broker: {} as unknown as Broker,
    clients: { authenticate: async () => null },
    owner,
    listen: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
    allowedOrigins: [ORIGIN],
    extensions: [routes()],
  });
  const path = "http://127.0.0.1:7451/v1/owner/hosts";
  // No session: nothing is listed.
  expect((await fetch(new Request(path))).status).toBe(403);
  // The panel signs in from its own origin and gets the session cookie.
  const login = await fetch(
    new Request("http://127.0.0.1:7451/v1/owner/login", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie.startsWith("hc_owner=hco_")).toBe(true);
  // A cross-site read is refused even with the cookie.
  expect(
    (
      await fetch(
        new Request(path, {
          headers: { cookie, "sec-fetch-site": "cross-site" },
        }),
      )
    ).status,
  ).toBe(403);
  const read = await fetch(
    new Request(path, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    }),
  );
  expect(read.status).toBe(200);
  expect(
    ((await read.json()) as { machines: unknown[] }).machines,
  ).toHaveLength(2);
  // Writes are POST only, and need the panel's Origin and the password.
  const write = (body: Record<string, unknown>, origin?: string) =>
    fetch(
      new Request("http://127.0.0.1:7451/v1/owner/hosts/access", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ name: "nas", access: "full", ...body }),
      }),
    );
  expect((await write({ password: PASSWORD })).status).toBe(403);
  expect((await write({ password: PASSWORD }, ORIGIN)).status).toBe(200);
  expect((await write({ password: "wrong" }, ORIGIN)).status).toBe(403);
  expect(
    (
      await fetch(
        new Request("http://127.0.0.1:7451/v1/owner/hosts/access", {
          headers: { cookie },
        }),
      )
    ).status,
  ).toBe(405);
});
