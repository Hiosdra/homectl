import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, credentialSpec, redactor } from "../src/credentials";
import {
  probeFailureMessage,
  provisioningFailureMessage,
  unameValue,
} from "../src/diagnostics";
import { enroll, installSudo } from "../src/enroll";
import { loadInventory, parseInventory, saveInventory } from "../src/inventory";
import { execute } from "../src/operations";
import {
  checkApproval,
  classify,
  planExecution,
  sudoers,
} from "../src/policies";
import { run } from "../src/process";
import {
  type API,
  type ProvisionRequest,
  planProvision,
  proxmox,
} from "../src/provisioners";
import { doctor, setup } from "../src/setup";
import { shellQuote, sshConfig, transportSpec } from "../src/transports";
import {
  HomectlError,
  type Inventory,
  type Machine,
  type ProcessSpec,
} from "../src/types";

const local: Machine = {
  description: "Test",
  transport: "local",
  access: "full",
};
const ssh: Machine = {
  description: "Test SSH",
  transport: "ssh",
  access: "full",
  ssh_alias: "example",
  address: "192.0.2.10",
  user: "operator",
  auth: {
    type: "keepassxc",
    socket: "/tmp/homectl-test/inventory.yaml.session/agent.sock",
    entry: "homectl-example",
    public_key: "/tmp/homectl-test/public-keys/example.pub",
  },
};
const inventory = (machine = local) =>
  ({
    version: 1,
    session: { ttl: "24h", database: "/tmp/homectl-test/homelab.kdbx" },
    machines: { example: machine },
  }) as Inventory;
const temp = () => mkdtemp(join(tmpdir(), "homectl-test-"));
const vm: ProvisionRequest = {
  provider: "example",
  vmid: 210,
  template: 9000,
  name: "test-vm",
  cpus: 4,
  memory_mb: 8192,
  disk_gb: 100,
  address: "192.0.2.20",
  cidr: 24,
  gateway: "192.0.2.1",
  bridge: "vmbr0",
  user: "debian",
  public_key: "ssh-ed25519 AAAA example",
  access: "full",
  packages: ["docker", "bun"],
};
const failure = (fn: () => unknown, code: number) => {
  try {
    fn();
    throw Error("did not reject");
  } catch (e) {
    expect(e).toBeInstanceOf(HomectlError);
    expect((e as HomectlError).code).toBe(code);
  }
};
describe("inventory", () => {
  test("parses complete YAML example", async () =>
    expect(
      Object.keys(
        parseInventory(
          await readFile(
            join(import.meta.dir, "../examples/inventory.example.yaml"),
            "utf8",
          ),
        ).machines,
      ),
    ).toHaveLength(4));
  test("roundtrips and saves outside repo", async () => {
    const path = join(await temp(), "inventory.yaml");
    await saveInventory(path, inventory());
    expect(await loadInventory(path)).toEqual(inventory());
  });
  for (const field of [
    "password",
    "private_key",
    "master_password",
    "api_secret",
    "recovery_codes",
  ])
    test(`rejects secret field ${field} without echoing value`, () => {
      const text = JSON.stringify({
        version: 1,
        machines: { example: { ...ssh, [field]: "fixture-credential" } },
      });
      try {
        parseInventory(text);
        throw Error("accepted");
      } catch (e) {
        expect(e).toBeInstanceOf(HomectlError);
        expect(JSON.stringify(e)).not.toContain("fixture-credential");
      }
    });
  test("rejects nested auth secrets", () =>
    failure(
      () =>
        parseInventory(
          JSON.stringify(
            inventory({
              ...ssh,
              auth: {
                ...ssh.auth,
                password: "fixture",
              } as Machine["auth"],
            }),
          ),
        ),
      2,
    ));
  test("rejects duplicate YAML keys", () =>
    failure(() => parseInventory("version: 1\nversion: 1\nmachines: {}"), 2));
  test("rejects duplicate aliases", () =>
    failure(
      () =>
        parseInventory(
          JSON.stringify({ version: 1, machines: { one: ssh, two: ssh } }),
        ),
      2,
    ));
  test("rejects config injection", () =>
    failure(
      () =>
        parseInventory(
          JSON.stringify(
            inventory({ ...ssh, address: "host\nProxyCommand evil" }),
          ),
        ),
      2,
    ));
  test("root SSH requires full", () =>
    failure(
      () =>
        parseInventory(
          JSON.stringify(inventory({ ...ssh, user: "root", access: "user" })),
        ),
      2,
    ));
  test("accepts mixed-case SSH usernames", () =>
    expect(
      parseInventory(
        JSON.stringify(inventory({ ...ssh, user: "MixedCaseUser" })),
      ).machines.example?.user,
    ).toBe("MixedCaseUser"));
  test("managed key requires an entry reference", () =>
    failure(
      () =>
        parseInventory(
          JSON.stringify(
            inventory({
              ...ssh,
              auth: { ...ssh.auth, entry: "" } as Machine["auth"],
            }),
          ),
        ),
      2,
    ));
  test("sudo-approved requires allowlist", () =>
    failure(
      () =>
        parseInventory(
          JSON.stringify(inventory({ ...ssh, access: "sudo-approved" })),
        ),
      2,
    ));
});
describe("policy", () => {
  for (const argv of [
    ["rm", "-rf", "/data"],
    ["docker", "volume", "rm", "db"],
    ["zfs", "destroy", "tank/backup"],
    ["qm", "destroy", "210"],
    ["apt-get", "purge", "postgresql"],
    ["mkfs.ext4", "/dev/sdb"],
    ["psql", "-c", "DROP DATABASE fixture"],
  ])
    test(`destructive ${argv.join(" ")}`, () =>
      expect(classify(argv)).toBe("destructive"));
  test("privilege is not destruction", () => {
    expect(classify(["sudo", "-n", "apt", "update"])).toBe("mutation");
    expect(classify(["sudo", "-n", "apt", "full-upgrade", "-y"])).toBe(
      "mutation",
    );
    expect(classify(["sudo", "-n", "systemctl", "restart", "klipper"])).toBe(
      "mutation",
    );
  });
  for (const argv of [
    ["sh", "-c", "rm /data"],
    ["env", "sudo", "rm", "/data"],
    ["find", "/data", "-delete"],
    ["bash", "-lc", "apt update"],
    ["custom-tool", "--reset"],
  ])
    test(`opaque ${argv.join(" ")}`, () =>
      expect(classify(argv)).toBe("opaque"));
  test("observe permits inspection and prevents mutation", () => {
    const m = { ...local, access: "observe" as const };
    expect(planExecution("example", m, ["df", "-h"]).classification).toBe(
      "inspect",
    );
    for (const argv of [
      ["rm", "x"],
      ["systemctl", "restart", "klipper"],
      ["journalctl", "--vacuum-time=1s"],
      ["hostname", "changed"],
      ["sh", "-c", "uptime"],
      ["sudo", "-n", "df"],
    ])
      failure(() => planExecution("example", m, argv), 3);
  });
  test("user prevents direct sudo and alternate escalation", () => {
    for (const argv of [
      ["sudo", "-n", "uptime"],
      ["doas", "uptime"],
      ["pkexec", "uptime"],
      ["su", "root"],
    ])
      failure(
        () => planExecution("example", { ...local, access: "user" }, argv),
        3,
      );
  });
  test("full permits sudo", () =>
    expect(
      planExecution("example", local, ["sudo", "-n", "apt", "update"])
        .needsApproval,
    ).toBe(false));
  test("sudo-approved uses exact argv not executable prefix", () => {
    const m = {
      ...local,
      access: "sudo-approved" as const,
      sudo_allow: [["/usr/bin/systemctl", "restart", "klipper"]],
    };
    expect(
      planExecution("example", m, [
        "sudo",
        "-n",
        "/usr/bin/systemctl",
        "restart",
        "klipper",
      ]).classification,
    ).toBe("mutation");
    failure(
      () =>
        planExecution("example", m, [
          "sudo",
          "-n",
          "/usr/bin/systemctl",
          "restart",
          "sshd",
        ]),
      3,
    );
  });
  test("destruction cannot execute without exact confirmation state", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    await expect(
      execute("example", local, ["rm", "fixture"], {
        configPath: "unused",
        runner,
      }),
    ).rejects.toMatchObject({ code: 4 });
    expect(calls).toBe(0);
    const p = planExecution(
      "example",
      local,
      ["rm", "fixture"],
      "Delete example fixture",
    );
    await execute("example", local, ["rm", "fixture"], {
      configPath: "unused",
      runner,
      approval: p.approval,
      impact: p.impact,
    });
    expect(calls).toBe(1);
  });
  test("approval binds machine config, argv and effects", () => {
    const p = planExecution("example", local, ["rm", "fixture"], "fixture");
    checkApproval(p, p.approval);
    for (const altered of [
      planExecution("other", local, p.argv, p.impact),
      planExecution(
        "example",
        { ...local, description: "Changed" },
        p.argv,
        p.impact,
      ),
      planExecution("example", local, ["rm", "other"], p.impact),
      planExecution("example", local, p.argv, "other scope"),
    ])
      failure(() => checkApproval(altered, p.approval), 4);
  });
  test("dry run never starts local, SSH or credential process", async () => {
    for (const m of [local, ssh]) {
      let called = false;
      const result = await execute("example", m, ["rm", "fixture"], {
        dryRun: true,
        configPath: "unused",
        runner: async () => {
          called = true;
          throw Error("executed");
        },
      });
      expect(result.plan.needsApproval).toBe(true);
      expect(called).toBe(false);
    }
  });
  test("renders accepted full policy and literal limited policy", () => {
    expect(sudoers("operator", local)).toBe(
      "operator ALL=(ALL:ALL) NOPASSWD: ALL\n",
    );
    expect(
      sudoers("operator", {
        ...local,
        access: "sudo-approved",
        sudo_allow: [["/usr/bin/true"]],
      }),
    ).toContain('/usr/bin/true ""');
    failure(
      () =>
        sudoers("operator", {
          ...local,
          access: "sudo-approved",
          sudo_allow: [["/bin/sh", "*"]],
        }),
      2,
    );
    failure(() => sudoers("root", local), 2);
  });
});
describe("diagnostics", () => {
  test("extracts uname after non-OS output", () =>
    expect(unameValue("connectivity probe started\nLinux\n")).toBe("Linux"));

  test("classifies host-key errors without suggesting an untrusted keyscan", () => {
    const message = probeFailureMessage({
      stdout: "",
      stderr: "Host key verification failed",
      exitCode: 255,
    });
    expect(message).toContain("trusted console");
    expect(message).toContain("do not trust a keyscan");
  });
  test("suppresses Proxmox worker diagnostics on failure", () => {
    const message = provisioningFailureMessage({
      stdout: "",
      stderr: "401: private-fixture",
      exitCode: 1,
    });
    expect(message).toContain("journal");
    expect(message).not.toContain("private-fixture");
  });
});
describe("transports and credentials", () => {
  test("local transport preserves argv", () =>
    expect(
      transportSpec(local, ["printf", "%s", "a b"], "unused").argv,
    ).toEqual(["printf", "%s", "a b"]));
  test("real local transport works", async () => {
    const result = await execute(
      "example",
      local,
      ["printf", "%s", "local fixture"],
      {
        configPath: "unused",
        approval: planExecution("example", local, [
          "printf",
          "%s",
          "local fixture",
        ]).approval,
      },
    );
    expect(result.result?.stdout).toBe("local fixture");
  });
  test("ssh quoting prevents argv becoming shell code", () => {
    const spec = transportSpec(
      ssh,
      ["printf", "%s", "x'; touch /tmp/nope; '"],
      "/config path",
    );
    expect(spec.argv).toContain("/config path");
    expect(spec.argv.at(-1)).toBe(
      "'printf' '%s' 'x'\\''; touch /tmp/nope; '\\''' ".trim(),
    );
    expect(spec.argv).toContain("StrictHostKeyChecking=yes");
  });
  test("shellQuote roundtrips literal substitutions", async () => {
    const value = "$(echo nope) a'b `echo nope`";
    const r = await run({
      argv: ["sh", "-c", `printf %s ${shellQuote(value)}`],
    });
    expect(r.stdout).toBe(value);
  });
  test("SSH aliases derive their address only from inventory", () => {
    const text = sshConfig({ example: ssh });
    expect(text).toContain("Host example\n  HostName 192.0.2.10");
    expect(text).toContain("ForwardAgent no");
  });
  test("key credentials use only socket reference", () => {
    const spec = credentialSpec(
      ssh.auth,
      transportSpec(ssh, ["uptime"], "/cfg"),
      "/worker",
    );
    expect(JSON.parse(spec.stdin ?? "{}").env).toEqual({
      SSH_AUTH_SOCK: ssh.auth?.socket,
    });
    expect(spec.argv).toEqual([process.execPath, "/worker"]);
  });

  test("sanitized environment drops credential-bearing variables", () =>
    expect(
      cleanEnv({
        PATH: "/bin",
        HOME: "/home/example",
        AWS_SECRET_ACCESS_KEY: "fixture",
        PRIVATE_SESSION: "fixture",
        PRIVATE_TOKEN: "fixture",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/example" }));
  test("redacts injected values, encodings, labelled values and private keys", () => {
    const redact = redactor(["fixture-password/42"]);
    const text = redact(
      `fixture-password/42 ${encodeURIComponent("fixture-password/42")} ${Buffer.from("fixture-password/42").toString("base64")} password=other-secret\n-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----`,
    );
    expect(text).not.toContain("fixture");
    expect(text).not.toContain("other-secret");
  });
  test("command failure never dumps secret environments", async () => {
    const r = await run({
      argv: ["sh", "-c", 'printf %s "$PRIVATE_TOKEN" >&2; exit 7'],
      env: { PRIVATE_TOKEN: "fixture-token" },
    });
    expect(r.exitCode).toBe(7);
    expect(r.stderr).toBe("[REDACTED]");
  });

  test("worker rejects wrong executable", async () => {
    const r = await run({
      argv: [
        process.execPath,
        join(import.meta.dir, "../src/credentials/worker.ts"),
        "ssh",
      ],
      env: { PRIVATE_PASSWORD: "test-only" },
      stdin: JSON.stringify({ argv: ["env"] }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("only supports OpenSSH");
  });
});
describe("setup and enrollment", () => {
  test("setup dry-run creates no config", async () => {
    const home = await temp();
    await setup(home, true);
    expect(
      await Bun.file(join(home, ".config/homectl/inventory.yaml")).exists(),
    ).toBe(false);
  });
  test("setup links both agent skill locations and is additive/idempotent", async () => {
    const home = await temp();
    await setup(home);
    await setup(home);
    const config = await readFile(join(home, ".ssh/config"), "utf8");
    expect(config.match(/Include/g)).toHaveLength(1);
    for (const root of [".agents", ".claude"])
      expect(
        await Bun.file(join(home, root, "skills/homelab/SKILL.md")).exists(),
      ).toBe(true);
  });
  test("enrollment verifies OS before saving", async () => {
    const dir = await temp();
    const path = join(dir, "inventory.yaml");
    await saveInventory(path, {
      version: 1,
      session: { ttl: "24h", database: "/tmp/homectl-test/homelab.kdbx" },
      machines: {},
    });
    let calls = 0;
    const result = await enroll("example", ssh, path, join(dir, "ssh_config"), {
      runner: async () => {
        calls++;
        return {
          stdout: "connectivity probe started\nLinux\n",
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(calls).toBe(1);
    expect(result.os).toBe("Linux");
    expect((await loadInventory(path)).machines.example).toEqual(ssh);
  });
  test("failed enrollment leaves inventory untouched", async () => {
    const dir = await temp();
    const path = join(dir, "inventory.yaml");
    await saveInventory(path, {
      version: 1,
      session: { ttl: "24h", database: "/tmp/homectl-test/homelab.kdbx" },
      machines: {},
    });
    await expect(
      enroll("example", ssh, path, join(dir, "ssh_config"), {
        runner: async () => ({
          stdout: "",
          stderr: "fixture failure",
          exitCode: 255,
        }),
      }),
    ).rejects.toMatchObject({ code: 5 });
    expect((await loadInventory(path)).machines).toEqual({});
  });
  test("sudo install never overwrites a different policy and uses no password argv", async () => {
    let seen: ProcessSpec | undefined;
    await installSudo("example", ssh, "/cfg", async (spec) => {
      seen = spec;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    expect(seen?.stdin).toContain("NOPASSWD: ALL");
    expect(JSON.parse(seen?.stdin ?? "{}").argv.at(-1)).toContain(
      "Existing sudoers differs",
    );
    expect(JSON.parse(seen?.stdin ?? "{}").argv.at(-1)).toContain("visudo -cf");
  });
  test("doctor does not run sudo for a root SSH account", async () => {
    const seen: ProcessSpec[] = [];
    await doctor(
      inventory({ ...ssh, user: "root" }),
      "/unused/ssh_config",
      "example",
      async (spec) => {
        seen.push(spec);
        return {
          stdout: "Linux\n",
          stderr: "",
          exitCode: 0,
        };
      },
    );
    expect(seen.some((spec) => spec.argv.includes("sudo"))).toBe(false);
    expect(seen.some((spec) => spec.argv.join(" ").includes("sudo"))).toBe(
      false,
    );
  });
});
describe("provisioning", () => {
  test("pure plan covers resources, public key, resize and boot", () => {
    const p = planProvision(vm, "pve");
    expect(p.steps.map((s) => s.id)).toEqual([
      "clone",
      "configure",
      "resize",
      "boot",
    ]);
    expect(p.steps[1]?.params.memory).toBe(8192);
    expect(p.steps[1]?.params.ipconfig0).toBe("ip=192.0.2.20/24,gw=192.0.2.1");
    expect(p.steps[2]?.params.size).toBe("100G");
  });
  test("accepts mixed-case cloud-init usernames", () =>
    expect(
      planProvision({ ...vm, user: "MixedCaseUser" }, "pve").machine.user,
    ).toBe("MixedCaseUser"));
  test("rejects unsafe identities, private keys and unsupported recipes", () => {
    for (const r of [
      { ...vm, vmid: vm.template },
      { ...vm, name: "bad;name" },
      { ...vm, address: "192.0.2.999" },
      { ...vm, public_key: "-----BEGIN PRIVATE KEY-----" },
      { ...vm, packages: ["codex"] },
    ])
      failure(() => planProvision(r as ProvisionRequest, "pve"), 2);
  });
  test("provider applies and then resumes without repeating mutations", async () => {
    const plan = planProvision(vm, "pve");
    let exists = false;
    const mutations: string[] = [];
    const api: API = {
      request: async (method, path) => {
        if (method === "GET")
          return path.endsWith("/config")
            ? { description: `homectl:${plan.fingerprint}`, name: vm.name }
            : exists
              ? [{ vmid: vm.vmid }]
              : [];
        mutations.push(path);
        if (path.endsWith("/clone")) exists = true;
        return "UPID:fixture";
      },
      wait: async () => {},
    };
    const dir = await temp();
    await proxmox.apply(plan, api, dir);
    await proxmox.apply(plan, api, dir);
    expect(mutations).toHaveLength(4);
  });
  test("VM collision cannot modify or destroy another VM", async () => {
    const api: API = {
      request: async (method, path) => {
        if (method !== "GET") throw Error("mutated");
        return path.endsWith("/config")
          ? { description: "other", name: "other" }
          : [{ vmid: vm.vmid }];
      },
      wait: async () => {},
    };
    await expect(
      proxmox.apply(planProvision(vm, "pve"), api, await temp()),
    ).rejects.toMatchObject({ code: 3 });
  });
  test("failed async task preserves pending stage and resumes", async () => {
    const plan = planProvision(vm, "pve");
    let exists = false,
      first = true;
    const mutations: string[] = [];
    const api: API = {
      request: async (method, path) => {
        if (method === "GET")
          return path.endsWith("/config")
            ? { description: `homectl:${plan.fingerprint}`, name: vm.name }
            : exists
              ? [{ vmid: vm.vmid }]
              : [];
        mutations.push(path);
        exists = true;
        return "UPID:fixture";
      },
      wait: async () => {
        if (first) {
          first = false;
          throw new HomectlError(5, "fixture timeout");
        }
      },
    };
    const dir = await temp();
    await expect(proxmox.apply(plan, api, dir)).rejects.toMatchObject({
      code: 5,
    });
    expect(
      JSON.parse(await readFile(join(dir, "example-210.json"), "utf8")).pending
        .step,
    ).toBe("clone");
    await proxmox.apply(plan, api, dir);
    expect(mutations.filter((v) => v.endsWith("/clone"))).toHaveLength(1);
  });
});

test("apt configuration hooks require review rather than being treated as routine update", () => {
  expect(
    classify([
      "sudo",
      "-n",
      "apt-get",
      "update",
      "-o",
      "APT::Update::Pre-Invoke=rm -rf /data",
    ]),
  ).toBe("opaque");
});
test("provisioning rejects unrecognized secret-bearing fields", () => {
  failure(
    () =>
      planProvision(
        { ...vm, password: "test-only" } as ProvisionRequest,
        "pve",
      ),
    2,
  );
});
