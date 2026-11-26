import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPermissionRoutes } from "../src/broker/host-permissions";
import {
  HomectlError,
  type Machine,
  type ProcessSpec,
  type Runner,
} from "../src/types";

const route = "/v1/owner/hosts/inspect";
const host = "lab";
const machine: Machine = {
  description: "Synthetic host",
  transport: "ssh",
  access: "observe",
  address: "192.0.2.10",
  user: "operator",
  port: 2222,
  auth: {
    type: "keepassxc",
    entry: "lab",
    socket: "/broker/agent",
    public_key: "/broker/lab.pub",
  },
};
const exactPin = "[192.0.2.10]:2222 ssh-ed25519 YQ==";
const revoked = "@revoked * ssh-ed25519 Yg==";
let dir: string;
let locked: boolean;
let calls: ProcessSpec[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-host-probe-"));
  locked = false;
  calls = [];
});
afterEach(async () => {
  await rm(join(dir, "known_hosts"), { force: true });
  await rmdir(dir);
});

function routes(resultCode = 0) {
  const runner: Runner = async (spec) => {
    calls.push(spec);
    const pins = spec.argv.find((arg) => arg.startsWith("UserKnownHostsFile="));
    if (!pins) throw new Error("Expected an isolated SSH pin file");
    const pinsPath = pins
      .slice('UserKnownHostsFile="'.length, -1)
      .replaceAll("\\\\", "\\");
    expect(await readFile(pinsPath, "utf8")).toBe(`${exactPin}\n${revoked}\n`);
    const command = spec.argv.at(-1);
    // No drop-in yet: cat fails and the absence check succeeds.
    const missingDropIn =
      command === "'sudo' '-n' 'cat' '/etc/sudoers.d/homectl-operator'";
    return {
      exitCode: missingDropIn ? 1 : resultCode,
      stderr: "ignored remote detail",
      stdout:
        command === "'uname' '-s' '-m'"
          ? "Linux x86_64"
          : command === "'cat' '/etc/os-release'"
            ? "ID=debian\nVERSION_ID=12"
            : command === "'id' '-u'"
              ? "1000"
              : "",
    };
  };
  return new HostPermissionRoutes(
    {
      machine: async (id) => (id === host ? machine : undefined),
      hosts: async () => [host],
    },
    join(dir, "inventory.yaml"),
    dir,
    () => (locked ? "Vault is locked" : undefined),
    runner,
  );
}

const stepUp = async (password: unknown) => {
  if (password !== "fixture") throw new HomectlError(3, "Wrong owner password");
};

test("probes the enrolled address through strict SSH and returns capabilities without remote diagnostics", async () => {
  await writeFile(
    join(dir, "known_hosts"),
    `* ssh-ed25519 Yw==\n${exactPin}\n${revoked}\n`,
  );
  const result = await routes().owner(
    route,
    { host, password: "fixture" },
    stepUp,
  );
  expect(result).toMatchObject({
    host,
    platform: { os: "linux", id: "debian" },
  });
  expect(JSON.stringify(result)).not.toContain("ignored remote detail");
  expect(calls[0]?.argv).toContain("StrictHostKeyChecking=yes");
  expect(calls[0]?.argv).toContain("GlobalKnownHostsFile=none");
  expect(calls[0]?.argv.slice(-3)).toEqual([
    "--",
    "192.0.2.10",
    "'cat' '/etc/os-release'",
  ]);
  expect(calls.every((spec) => spec.stdin === undefined)).toBe(true);
  expect(await readdir(dir)).toEqual(["known_hosts"]);
});

test("refuses wrong owner password, missing pins, and locked credentials before SSH", async () => {
  const handler = routes();
  await expect(
    handler.owner(route, { host, password: "wrong" }, stepUp),
  ).rejects.toThrow("Wrong owner password");
  await writeFile(join(dir, "known_hosts"), "* ssh-ed25519 Yw==\n");
  await expect(
    handler.owner(route, { host, password: "fixture" }, stepUp),
  ).rejects.toThrow("Confirm and pin");
  await writeFile(join(dir, "known_hosts"), `${exactPin}\n${revoked}\n`);
  locked = true;
  await expect(
    handler.owner(route, { host, password: "fixture" }, stepUp),
  ).rejects.toThrow("Vault is locked");
  expect(calls).toHaveLength(0);
  expect(await readdir(dir)).toEqual(["known_hosts"]);
});

test("an SSH transport failure stops inspection and removes its temporary pins", async () => {
  await writeFile(join(dir, "known_hosts"), `${exactPin}\n${revoked}\n`);
  await expect(
    routes(255).owner(route, { host, password: "fixture" }, stepUp),
  ).rejects.toThrow("SSH inspection failed");
  expect(calls).toHaveLength(1);
  expect(await readdir(dir)).toEqual(["known_hosts"]);
});

test("grant preview shows the literal sudo rule from inventory without writing remotely", async () => {
  await writeFile(join(dir, "known_hosts"), `${exactPin}\n${revoked}\n`);
  machine.sudo_allow = [["/usr/bin/systemctl", "restart", "fixture.service"]];
  try {
    const result = await routes().owner(
      "/v1/owner/hosts/preview-grant",
      { host, password: "fixture" },
      stepUp,
    );
    expect(result).toMatchObject({
      host,
      grant: {
        path: "/etc/sudoers.d/homectl-operator",
        changed: true,
        foreign: false,
        diff: expect.stringContaining(
          "/usr/bin/systemctl restart fixture.service",
        ),
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    // Read-only: nothing that writes, moves or deletes ran on the host.
    const commands = calls.map((spec) => spec.argv.at(-1) ?? "");
    expect(commands.some((c) => /'(install|mv|rm|cp|visudo)'/.test(c))).toBe(
      false,
    );
    expect(await readdir(dir)).toEqual(["known_hosts"]);
  } finally {
    delete machine.sudo_allow;
  }
});
