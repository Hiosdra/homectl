import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerPath } from "../src/operations";
import { planProvision, proxmox } from "../src/provisioners";
import { proxmoxSSH } from "../src/provisioners/ssh";
import { shellQuote } from "../src/transports";
import type {
  Machine,
  ProcessResult,
  ProcessSpec,
  ProviderConfig,
} from "../src/types";

// No real runner, sockets, credentials or network. Capture the actual worker
// payload and simulate pvesh's JSON responses at the process boundary.
const host: Machine = {
  description: "Synthetic Proxmox",
  transport: "ssh",
  access: "full",
  ssh_alias: "fixture-pve",
  address: "192.0.2.1",
  user: "root",
  auth: {
    type: "keepassxc",
    entry: "homectl-fixture-pve",
    socket: "/tmp/fixture.yaml.session/agent.sock",
    public_key: "/tmp/fixture-pve.pub",
  },
};
const provider: ProviderConfig = {
  type: "proxmox",
  host: "fixture-pve",
  node: "pve",
};
const task = "UPID:pve:000001:000002:000003:qmclone:210:root@pam:";
function fixture(
  response: (inner: ProcessSpec, index: number) => ProcessResult = () => ({
    stdout: "[]",
    stderr: "",
    exitCode: 0,
  }),
  machine = host,
  timeoutMs = 2000,
) {
  const outer: ProcessSpec[] = [];
  const calls: ProcessSpec[] = [];
  const api = proxmoxSSH(
    provider,
    machine,
    "/tmp/fixture-ssh-config",
    async (spec) => {
      outer.push(spec);
      const inner = JSON.parse(spec.stdin ?? "{}") as ProcessSpec;
      calls.push(inner);
      return response(inner, calls.length - 1);
    },
    { timeoutMs, intervalMs: 1 },
  );
  return { api, calls, outer };
}
const json = (value: unknown): ProcessResult => ({
  stdout: JSON.stringify(value),
  stderr: "",
  exitCode: 0,
});
const remote = (args: string[]) => args.map(shellQuote).join(" ");

test("GET reaches pvesh through the managed SSH worker with strict host checking", async () => {
  const f = fixture(() => json([{ vmid: 210 }]));
  expect(await f.api.request("GET", "/nodes/pve/qemu")).toEqual([
    { vmid: 210 },
  ]);
  expect(f.outer[0]?.argv).toEqual([process.execPath, workerPath]);
  const ssh = f.calls[0];
  expect(ssh?.env?.SSH_AUTH_SOCK).toBe(host.auth?.socket);
  expect(ssh?.argv).toContain("StrictHostKeyChecking=yes");
  expect(ssh?.argv).toContain("ForwardAgent=no");
  expect(ssh?.argv).toContain("BatchMode=yes");
  expect(ssh?.argv).toContain("/tmp/fixture-ssh-config");
  expect(ssh?.argv.at(-1)).toBe(
    remote([
      "pvesh",
      "--noproxy",
      "get",
      "/nodes/pve/qemu",
      "--output-format",
      "json",
    ]),
  );
});
for (const [method, path, verb] of [
  ["POST", "/nodes/pve/qemu/9000/clone", "create"],
  ["POST", "/nodes/pve/qemu/210/status/start", "create"],
  ["PUT", "/nodes/pve/qemu/210/config", "set"],
  ["PUT", "/nodes/pve/qemu/210/resize", "set"],
] as const) {
  test(`${method} ${path} maps to pvesh ${verb}`, async () => {
    const f = fixture(() => json(null));
    expect(await f.api.request(method, path)).toBeNull();
    expect(f.calls[0]?.argv.at(-1)).toBe(
      remote(["pvesh", "--noproxy", verb, path, "--output-format", "json"]),
    );
  });
}
test("non-root full host runs pvesh with noninteractive sudo", async () => {
  const f = fixture(undefined, { ...host, user: "operator" });
  await f.api.request("GET", "/nodes/pve/qemu");
  expect(f.calls[0]?.argv.at(-1)).toBe(
    remote([
      "sudo",
      "-n",
      "pvesh",
      "--noproxy",
      "get",
      "/nodes/pve/qemu",
      "--output-format",
      "json",
    ]),
  );
});
test("cloud-init SSH keys are URL-encoded once and other parameters stay literal", async () => {
  const key = "ssh-ed25519 A+/= fixture@example\n";
  const name = "value'; $(touch /tmp/should-not-exist)";
  const f = fixture();
  await f.api.request("PUT", "/nodes/pve/qemu/210/config", {
    sshkeys: key,
    description: name,
    cores: 4,
  });
  expect(f.calls[0]?.argv.at(-1)).toBe(
    remote([
      "pvesh",
      "--noproxy",
      "set",
      "/nodes/pve/qemu/210/config",
      "--output-format",
      "json",
      "--sshkeys",
      encodeURIComponent(key),
      "--description",
      name,
      "--cores",
      "4",
    ]),
  );
});
test("invalid hosts and node names are rejected", () => {
  for (const machine of [
    { ...host, access: "user" as const },
    { ...host, transport: "local" as const },
    { ...host, auth: undefined },
  ])
    expect(() => proxmoxSSH(provider, machine, "unused")).toThrow();
  expect(() =>
    proxmoxSSH({ ...provider, node: "pve/../other" }, host, "unused"),
  ).toThrow();
});
test("unsupported resources, methods and encoded traversal never start a process", async () => {
  const f = fixture();
  for (const [method, path] of [
    ["GET", "/nodes/other/qemu"],
    ["GET", "/nodes/pve/storage"],
    ["POST", "/nodes/pve/qemu/210/config"],
    ["PUT", "/nodes/pve/qemu/210/status/start"],
    ["DELETE", "/nodes/pve/qemu/210"],
    ["GET", "/nodes/pve/tasks/UPID%3Apve%2F..%2Fother/status"],
    ["GET", "/nodes/pve/tasks/UPID%3Apve%ZZ/status"],
  ])
    await expect(
      f.api.request(method as "GET", path ?? ""),
    ).rejects.toMatchObject({ code: 2 });
  await expect(
    f.api.request("PUT", "/nodes/pve/qemu/210/config", { "bad-name": "x" }),
  ).rejects.toMatchObject({ code: 2 });
  expect(f.calls).toHaveLength(0);
});
test("empty output is accepted for operations without a result", async () => {
  const f = fixture(() => ({ stdout: "\n", stderr: "", exitCode: 0 }));
  expect(await f.api.request("PUT", "/nodes/pve/qemu/210/config")).toBeNull();
});
test("invalid JSON and failed SSH suppress raw diagnostics", async () => {
  for (const result of [
    { stdout: "private-fixture", stderr: "", exitCode: 0 },
    {
      stdout: "private-fixture",
      stderr: "Permission denied (publickey): private-fixture",
      exitCode: 255,
    },
  ]) {
    try {
      await fixture(() => result).api.request("GET", "/nodes/pve/qemu");
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toMatchObject({ code: 5 });
      expect(String(error)).not.toContain("private-fixture");
    }
  }
});
test("task wait decodes UPID for pvesh and polls until OK", async () => {
  const f = fixture((_spec, i) =>
    json(
      i === 0 ? { status: "running" } : { status: "stopped", exitstatus: "OK" },
    ),
  );
  await f.api.wait(task);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]?.argv.at(-1)).toBe(
    remote([
      "pvesh",
      "--noproxy",
      "get",
      `/nodes/pve/tasks/${task}/status`,
      "--output-format",
      "json",
    ]),
  );
});
test("invalid task IDs are rejected without calling SSH", async () => {
  const f = fixture();
  await expect(f.api.wait("UPID:pve/../other")).rejects.toMatchObject({
    code: 5,
  });
  expect(f.calls).toHaveLength(0);
});
test("task errors and malformed task state fail with sanitized errors", async () => {
  for (const state of [
    null,
    {},
    { status: "unknown-private-fixture" },
    { status: "stopped", exitstatus: "private-fixture" },
  ]) {
    try {
      await fixture(() => json(state)).api.wait(task);
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toMatchObject({ code: 5 });
      expect(String(error)).not.toContain("private-fixture");
    }
  }
});
test("a task that stays running reaches the bounded timeout", async () => {
  const f = fixture(() => json({ status: "running" }), host, 30);
  await expect(f.api.wait(task)).rejects.toMatchObject({ code: 5 });
  expect(f.calls.length).toBeGreaterThan(0);
});
test("a complete provisioning plan uses the SSH adapter and can resume without another mutation", async () => {
  let created = false;
  let planFingerprint = "";
  let mutations = 0;
  const f = fixture((spec) => {
    const cmd = spec.argv.at(-1) ?? "";
    if (cmd.includes("'get'")) {
      if (cmd.includes("'/nodes/pve/qemu'"))
        return json(created ? [{ vmid: 210 }] : []);
      if (cmd.includes("'/nodes/pve/qemu/210/config'"))
        return json({
          name: "fixture-vm",
          description: `homectl:${planFingerprint}`,
        });
      return json({ status: "stopped", exitstatus: "OK" });
    }
    mutations++;
    if (cmd.includes("'/nodes/pve/qemu/9000/clone'")) created = true;
    return json(task);
  });
  const plan = planProvision(
    {
      provider: "fixture-pve",
      vmid: 210,
      template: 9000,
      name: "fixture-vm",
      cpus: 2,
      memory_mb: 1024,
      disk_gb: 20,
      address: "192.0.2.2",
      cidr: 24,
      gateway: "192.0.2.254",
      bridge: "vmbr0",
      user: "debian",
      public_key: "ssh-ed25519 AAAA fixture",
      access: "full",
    },
    "pve",
  );
  planFingerprint = plan.fingerprint;
  const dir = await mkdtemp(join(tmpdir(), "hctpve-"));
  try {
    await proxmox.apply(plan, f.api, dir);
    expect(mutations).toBe(4);
    await proxmox.apply(plan, f.api, dir);
    expect(mutations).toBe(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
