import { describe, expect, test } from "bun:test";
import {
  addAuthorizedKey,
  applyGrant,
  detectPlatform,
  planAccount,
  planGrant,
  removeAuthorizedKey,
  renderDropIn,
  revokeGrant,
} from "../src/hostperm";
import { FakeHost, writeTargets } from "./hostperm-fake-remote";

// Native commands only (C2): no package manager, downloader, shell or remote helper.
const ALLOWED_COMMANDS = new Set([
  "true",
  "uname",
  "id",
  "cat",
  "test",
  "grep",
  "install",
  "cp",
  "mv",
  "rm",
  "visudo",
  "sha256sum",
  "useradd",
  // sudo -n -l -U USER: the second element after "sudo -n" is "-l".
  "-l",
]);
const FORBIDDEN = [
  "apt",
  "apt-get",
  "dpkg",
  "dnf",
  "yum",
  "zypper",
  "pacman",
  "apk",
  "brew",
  "pip",
  "npm",
  "bun",
  "curl",
  "wget",
  "sh",
  "bash",
  "scp",
  "rsync",
  "ssh",
  "git",
];

const HOME = "/home/oskar";
const AUTH = `${HOME}/.ssh/authorized_keys`;
const AUTH_TMP = `${HOME}/.ssh/.authorized_keys.homectl-new`;
const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const OTHER = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 admin@desk";

// A write may only touch homectl's sudoers files or authorized_keys and its temp.
const ALLOWED_WRITE =
  /^(\/etc\/sudoers\.d\/\.?homectl-oskar(\.new|\.bak)?|\/home\/oskar\/\.ssh|\/home\/oskar\/\.ssh\/authorized_keys|\/home\/oskar\/\.ssh\/\.authorized_keys\.homectl-new)$/;

function snapshot(host: FakeHost): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, file] of host.files)
    out.set(
      path,
      JSON.stringify([
        file.content,
        file.mode,
        file.owner,
        file.group,
        file.link,
      ]),
    );
  return out;
}

function changedPaths(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

describe("agentless safety", () => {
  test("every issued command is native, and none is a shell or package tool", async () => {
    const host = new FakeHost();
    await detectPlatform(host.exec);
    const plan = await planGrant(
      host.exec,
      "oskar",
      renderDropIn(
        "oskar",
        { kind: "allow", argv: [["/usr/bin/systemctl", "status", "sshd"]] },
        "grant-a",
      ),
    );
    await applyGrant(host.exec, plan);
    await addAuthorizedKey(host.exec, {
      user: "oskar",
      home: HOME,
      useSudo: true,
      publicKey: KEY,
      id: "x",
    });
    await removeAuthorizedKey(host.exec, {
      user: "oskar",
      home: HOME,
      useSudo: true,
      id: "x",
    });
    await revokeGrant(host.exec, "oskar");

    expect(host.log.length).toBeGreaterThan(10);
    for (const entry of host.log) {
      const command =
        entry.argv[0] === "sudo"
          ? (entry.argv[2] ?? "")
          : (entry.argv[0] ?? "");
      expect(ALLOWED_COMMANDS.has(command)).toBe(true);
      expect(FORBIDDEN).not.toContain(command);
      for (const arg of entry.argv) {
        // The sudoers grep pattern legitimately contains "|" and "$"; only shell
        // sequences would matter, and argv never reaches a shell anyway.
        expect(/;|`|\$\(|&&|\|\|/.test(arg)).toBe(false);
        expect(arg).not.toMatch(/https?:/);
      }
    }
  });

  test("a full lifecycle writes only homectl sudoers files and authorized_keys", async () => {
    const host = new FakeHost();
    const before = snapshot(host);
    const plan = await planGrant(
      host.exec,
      "oskar",
      renderDropIn("oskar", { kind: "full" }, "grant-a"),
    );
    expect((await applyGrant(host.exec, plan)).status).toBe("applied");
    expect(
      (
        await addAuthorizedKey(host.exec, {
          user: "oskar",
          home: HOME,
          useSudo: true,
          publicKey: KEY,
          id: "laptop",
        })
      ).status,
    ).toBe("added");
    expect(
      (
        await removeAuthorizedKey(host.exec, {
          user: "oskar",
          home: HOME,
          useSudo: true,
          id: "laptop",
        })
      ).status,
    ).toBe("removed");
    expect((await revokeGrant(host.exec, "oskar")).status).toBe("removed");

    // Revoke removes the drop-in completely. The key add/remove leaves an
    // empty authorized_keys behind, because the file did not exist before.
    const after = snapshot(host);
    expect(changedPaths(before, after)).toEqual([AUTH]);
    expect(host.text(AUTH)).toBe("");
    for (const entry of host.log)
      for (const target of writeTargets(entry.argv))
        if (target !== "") expect(target).toMatch(ALLOWED_WRITE);
  });

  test("unrelated sudoers drop-ins and the main sudoers file are never touched", async () => {
    const host = new FakeHost();
    host.put(AUTH, `${OTHER}\n`, {
      owner: "oskar",
      group: "oskar",
      mode: "0600",
    });
    host.put("/etc/sudoers.d/someone-else", "admin ALL=(ALL) ALL\n");
    const before = snapshot(host);
    const plan = await planGrant(
      host.exec,
      "oskar",
      renderDropIn(
        "oskar",
        { kind: "allow", argv: [["/usr/bin/true"]] },
        "grant-a",
      ),
    );
    await applyGrant(host.exec, plan);
    await addAuthorizedKey(host.exec, {
      user: "oskar",
      home: HOME,
      useSudo: true,
      publicKey: KEY,
      id: "x",
    });
    const changed = changedPaths(before, snapshot(host));
    expect(changed).toEqual([AUTH, "/etc/sudoers.d/homectl-oskar"].sort());
    expect(host.text("/etc/sudoers.d/someone-else")).toBe(
      "admin ALL=(ALL) ALL\n",
    );
    expect(host.text("/etc/sudoers")).toBe(
      "root ALL=(ALL:ALL) ALL\n#includedir /etc/sudoers.d\n",
    );
  });

  test("temporary files created during writes are confined to the expected names", async () => {
    const host = new FakeHost();
    const plan = await planGrant(
      host.exec,
      "oskar",
      renderDropIn("oskar", { kind: "full" }, "grant-a"),
    );
    host.failIf = (argv) => argv.includes("visudo") && argv.includes("-cf");
    await applyGrant(host.exec, plan);
    await addAuthorizedKey(host.exec, {
      user: "oskar",
      home: HOME,
      useSudo: true,
      publicKey: KEY,
      id: "x",
    });
    const targets = host.log.flatMap((entry) => writeTargets(entry.argv));
    expect(
      targets.filter((t) => t !== "").every((t) => ALLOWED_WRITE.test(t)),
    ).toBe(true);
    expect(targets).toContain(AUTH_TMP);
  });

  test("an appliance without visudo or useradd gets an unsupported account plan", async () => {
    const host = new FakeHost();
    host.osRelease = "ID=examplenas\n";
    host.executables.delete("/usr/sbin/visudo");
    host.executables.delete("/usr/sbin/useradd");
    const platform = await detectPlatform(host.exec);
    expect(platform.supports.dropIns).toBe(false);
    const plan = planAccount("dedicated", platform, { user: "homectl" });
    expect(plan.supported).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.reasons.length).toBeGreaterThan(0);
  });

  test("dedicated accounts are refused when sudo -n is unavailable", async () => {
    const host = new FakeHost();
    host.sudoWorks = false;
    const platform = await detectPlatform(host.exec);
    expect(
      planAccount("dedicated", platform, { user: "homectl" }).supported,
    ).toBe(false);
    expect(host.users.has("homectl")).toBe(false);
  });

  test("a platform probe never writes to the host", async () => {
    const host = new FakeHost();
    const before = snapshot(host);
    await detectPlatform(host.exec);
    expect(changedPaths(before, snapshot(host))).toEqual([]);
    expect(
      host.log.every((entry) => writeTargets(entry.argv).length === 0),
    ).toBe(true);
  });
});
