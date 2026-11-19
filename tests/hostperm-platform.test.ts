import { describe, expect, test } from "bun:test";
import {
  type BatchHost,
  detectPlatform,
  parseOsRelease,
  planAccount,
  planBatch,
  renderDropIn,
} from "../src/hostperm";
import { FakeHost } from "./hostperm-fake-remote";

describe("detectPlatform", () => {
  test("a standard Debian host supports drop-ins, dedicated accounts and authorized_keys", async () => {
    const host = new FakeHost();
    const platform = await detectPlatform(host.exec);
    expect(platform.os).toBe("linux");
    expect(platform.id).toBe("debian");
    expect(platform.versionId).toBe("12");
    expect(platform.canSudo).toBe(true);
    expect(platform.isRoot).toBe(false);
    expect(platform.appliance).toBe(false);
    expect(platform.supports).toEqual({
      dropIns: true,
      dedicatedAccount: true,
      authorizedKeys: true,
    });
    expect(platform.reasons).toEqual([]);
  });

  test("probes use argv arrays and never a shell", async () => {
    const host = new FakeHost();
    await detectPlatform(host.exec);
    for (const entry of host.log) {
      expect(["sh", "bash", "zsh"]).not.toContain(entry.argv[0] ?? "");
      expect(
        entry.argv.some((arg) => arg.includes(" && ") || arg.includes(";")),
      ).toBe(false);
    }
  });

  test("an unrecognised system without useradd is an appliance with no new accounts", async () => {
    const host = new FakeHost();
    host.osRelease = 'ID=examplenas\nID_LIKE=""\n';
    host.executables.delete("/usr/sbin/useradd");
    const platform = await detectPlatform(host.exec);
    expect(platform.appliance).toBe(true);
    expect(platform.supports.dedicatedAccount).toBe(false);
    expect(platform.reasons.join(" ")).toContain("appliance");
    expect(platform.supports.dropIns).toBe(true);
  });

  test("a read-only /etc under sudo disables drop-ins with a reason", async () => {
    const host = new FakeHost();
    host.readOnlyEtc = true;
    const platform = await detectPlatform(host.exec);
    expect(platform.readOnlyEtc).toBe(true);
    expect(platform.appliance).toBe(true);
    expect(platform.supports.dropIns).toBe(false);
    expect(platform.reasons.join(" ")).toContain("not writable");
  });

  test("missing visudo leaves drop-ins unsupported with a reason", async () => {
    const host = new FakeHost();
    host.executables.delete("/usr/sbin/visudo");
    const platform = await detectPlatform(host.exec);
    expect(platform.supports.dropIns).toBe(false);
    expect(platform.reasons.join(" ")).toContain("visudo");
  });

  test("no sudo -n disables every privileged capability", async () => {
    const host = new FakeHost();
    host.sudoWorks = false;
    const platform = await detectPlatform(host.exec);
    expect(platform.canSudo).toBe(false);
    expect(platform.supports).toEqual({
      dropIns: false,
      dedicatedAccount: false,
      authorizedKeys: false,
    });
    expect(platform.reasons.join(" ")).toContain("sudo -n is unavailable");
  });

  test("a missing sudoers include is reported, not assumed", async () => {
    const host = new FakeHost();
    host.sudoersInclude = false;
    const platform = await detectPlatform(host.exec);
    expect(platform.supports.dropIns).toBe(false);
    expect(platform.reasons.join(" ")).toContain("includedir");
  });

  test("darwin without os-release supports drop-ins but not dedicated accounts", async () => {
    const host = new FakeHost();
    host.osRelease = undefined;
    host.uname = "Darwin arm64";
    host.executables.delete("/usr/sbin/useradd");
    const platform = await detectPlatform(host.exec);
    expect(platform.os).toBe("darwin");
    expect(platform.id).toBeUndefined();
    expect(platform.supports.dropIns).toBe(true);
    expect(platform.supports.dedicatedAccount).toBe(false);
  });

  test("an unrecognised kernel is unknown and supports nothing", async () => {
    const host = new FakeHost();
    host.uname = "Plan9 386";
    const platform = await detectPlatform(host.exec);
    expect(platform.os).toBe("unknown");
    expect(platform.supports).toEqual({
      dropIns: false,
      dedicatedAccount: false,
      authorizedKeys: false,
    });
  });

  test("root without sudo is reported as limited, and uid 0 is recognised", async () => {
    const host = new FakeHost();
    host.uid = "0";
    host.sudoWorks = false;
    const platform = await detectPlatform(host.exec);
    expect(platform.isRoot).toBe(true);
    expect(platform.canSudo).toBe(false);
  });
});

describe("parseOsRelease", () => {
  test("strips quotes and reads ID_LIKE tokens", () => {
    expect(
      parseOsRelease('ID="ubuntu"\nID_LIKE="debian"\nVERSION_ID=\'24.04\'\n'),
    ).toEqual({
      id: "ubuntu",
      idLike: ["debian"],
      versionId: "24.04",
    });
  });
});

describe("planAccount", () => {
  test("dedicated account uses the exact useradd argv with no password or sshd change", async () => {
    const host = new FakeHost();
    const platform = await detectPlatform(host.exec);
    const plan = planAccount("dedicated", platform, { user: "homectl" });
    expect(plan.supported).toBe(true);
    expect(plan.steps).toEqual([
      {
        id: "create-account",
        argv: [
          "sudo",
          "-n",
          "useradd",
          "--create-home",
          "--shell",
          "/bin/sh",
          "homectl",
        ],
        purpose: "create a dedicated account without a password",
      },
    ]);
    const commands = JSON.stringify(plan.steps);
    expect(commands).not.toContain("passwd");
    expect(commands).not.toContain("sshd_config");
  });

  test("dedicated account is refused on an appliance, with the platform reasons", async () => {
    const host = new FakeHost();
    host.osRelease = "ID=examplenas\n";
    host.executables.delete("/usr/sbin/useradd");
    const platform = await detectPlatform(host.exec);
    const plan = planAccount("dedicated", platform, { user: "homectl" });
    expect(plan.supported).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.reasons.length).toBeGreaterThan(0);
  });

  test("existing admin needs sudo -n and creates no account", async () => {
    const host = new FakeHost();
    const platform = await detectPlatform(host.exec);
    const plan = planAccount("existing-admin", platform, { user: "oskar" });
    expect(plan).toMatchObject({ supported: true, steps: [] });
    const noSudo = new FakeHost();
    noSudo.sudoWorks = false;
    const limited = planAccount(
      "existing-admin",
      await detectPlatform(noSudo.exec),
      {
        user: "oskar",
      },
    );
    expect(limited.supported).toBe(false);
  });

  test("existing restricted account is supported only with authorized_keys support", async () => {
    const host = new FakeHost();
    const platform = await detectPlatform(host.exec);
    expect(
      planAccount("existing-restricted", platform, { user: "svc" }).supported,
    ).toBe(true);
  });

  test("root and invalid names are never planned", async () => {
    const host = new FakeHost();
    const platform = await detectPlatform(host.exec);
    expect(
      planAccount("existing-admin", platform, { user: "root" }).supported,
    ).toBe(false);
    expect(
      planAccount("dedicated", platform, { user: "Bad.Name" }).supported,
    ).toBe(false);
  });
});

describe("planBatch", () => {
  test("one consolidated review list with create, update, none and skip", async () => {
    const desired = renderDropIn("oskar", { kind: "full" }, "grant-a");
    const other = renderDropIn(
      "oskar",
      { kind: "allow", argv: [["/usr/bin/true"]] },
      "grant-a",
    );
    const fresh = new FakeHost();
    const same = new FakeHost();
    same.put("/etc/sudoers.d/homectl-oskar", desired);
    const changed = new FakeHost();
    changed.put("/etc/sudoers.d/homectl-oskar", other);
    const foreign = new FakeHost();
    foreign.put("/etc/sudoers.d/homectl-oskar", "oskar ALL=(ALL) ALL\n");
    const drifted = new FakeHost();
    // Header hash deliberately does not match the body: edited after install.
    drifted.put(
      "/etc/sudoers.d/homectl-oskar",
      `# homectl-managed id=grant-a sha256=${"0".repeat(64)}\ntampered\n`,
    );
    const appliance = new FakeHost();
    appliance.osRelease = "ID=examplenas\n";
    appliance.readOnlyEtc = true;

    const hosts: BatchHost[] = [
      {
        name: "fresh",
        platform: await detectPlatform(fresh.exec),
        current: undefined,
        desired,
      },
      {
        name: "same",
        platform: await detectPlatform(same.exec),
        current: same.text("/etc/sudoers.d/homectl-oskar"),
        desired,
      },
      {
        name: "changed",
        platform: await detectPlatform(changed.exec),
        current: changed.text("/etc/sudoers.d/homectl-oskar"),
        desired,
      },
      {
        name: "foreign",
        platform: await detectPlatform(foreign.exec),
        current: foreign.text("/etc/sudoers.d/homectl-oskar"),
        desired,
      },
      {
        name: "drifted",
        platform: await detectPlatform(drifted.exec),
        current: drifted.text("/etc/sudoers.d/homectl-oskar"),
        desired,
      },
      {
        name: "appliance",
        platform: await detectPlatform(appliance.exec),
        current: undefined,
        desired,
      },
      {
        name: "fresh",
        platform: await detectPlatform(fresh.exec),
        current: undefined,
        desired,
      },
    ];
    const review = planBatch(hosts);
    expect(review.map((item) => [item.host, item.action])).toEqual([
      ["fresh", "create"],
      ["same", "none"],
      ["changed", "update"],
      ["foreign", "skip"],
      ["drifted", "skip"],
      ["appliance", "skip"],
      ["fresh", "skip"],
    ]);
    expect(review[3]?.reason).toContain("foreign");
    expect(review[5]?.reason).toContain("unsupported");
  });

  test("a desired value without a valid header is skipped, not planned", async () => {
    const host = new FakeHost();
    const review = planBatch([
      {
        name: "x",
        platform: await detectPlatform(host.exec),
        desired: "oskar ALL=(ALL) ALL\n",
      },
    ]);
    expect(review[0]?.action).toBe("skip");
  });
});
