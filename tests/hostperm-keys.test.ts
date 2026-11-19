import { describe, expect, test } from "bun:test";
import {
  addAuthorizedKey,
  editAddKey,
  editRemoveKey,
  keyTag,
  removeAuthorizedKey,
} from "../src/hostperm";
import { HomectlError } from "../src/types";
import { FakeHost } from "./hostperm-fake-remote";

const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB laptop";
const AUTH = "/home/oskar/.ssh/authorized_keys";
const HOME = "/home/oskar";
const OTHER_LINE = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 admin@desk";

const target = { user: "oskar", home: HOME, useSudo: true };

function writes(host: FakeHost): string[][] {
  return host.log
    .map((entry) => entry.argv)
    .filter((argv) =>
      ["install", "mv", "cp", "rm"].some((w) => argv.includes(w)),
    );
}

describe("pure edits", () => {
  test("editAddKey appends a tagged line and keeps every other byte", () => {
    const current = `${OTHER_LINE}\n# comment\n`;
    const edit = editAddKey(current, KEY_A, "laptop-1");
    expect(edit.changed).toBe(true);
    expect(edit.next).toBe(`${current}${KEY_A} homectl:laptop-1\n`);
  });

  test("editAddKey adds a newline before the new line when the file lacks one", () => {
    expect(editAddKey(OTHER_LINE, KEY_A, "x").next).toBe(
      `${OTHER_LINE}\n${KEY_A} homectl:x\n`,
    );
    expect(editAddKey("", KEY_A, "x").next).toBe(`${KEY_A} homectl:x\n`);
  });

  test("editAddKey is idempotent for the same key and id", () => {
    const once = editAddKey("", KEY_A, "x").next;
    const twice = editAddKey(once, KEY_A, "x");
    expect(twice.changed).toBe(false);
    expect(twice.next).toBe(once);
  });

  test("editAddKey leaves a key that is already present untagged", () => {
    const current = `${KEY_A}\n`;
    expect(editAddKey(current, KEY_A, "x")).toMatchObject({
      changed: false,
      next: current,
    });
  });

  test("editRemoveKey drops only lines tagged with that id", () => {
    const current = `${OTHER_LINE}\n${KEY_A} homectl:x\n${KEY_B} homectl:y\n`;
    const edit = editRemoveKey(current, "x");
    expect(edit).toMatchObject({ changed: true, removed: 1 });
    expect(edit.next).toBe(`${OTHER_LINE}\n${KEY_B} homectl:y\n`);
  });

  test("editRemoveKey without a matching tag changes nothing", () => {
    const current = `${OTHER_LINE}\n${KEY_A}\n`;
    expect(editRemoveKey(current, "x")).toMatchObject({
      changed: false,
      next: current,
    });
  });

  test("keyTag reads only a trailing homectl tag", () => {
    expect(keyTag(`${KEY_A} homectl:abc`)).toBe("abc");
    expect(keyTag(`${KEY_A} notes homectl:abc more`)).toBeUndefined();
  });
});

describe("addAuthorizedKey", () => {
  test("appends to an existing file, preserves other lines, owner oskar 0600", async () => {
    const host = new FakeHost();
    host.put(AUTH, `${OTHER_LINE}\n`, {
      owner: "oskar",
      group: "oskar",
      mode: "0600",
    });
    const report = await addAuthorizedKey(host.exec, {
      ...target,
      publicKey: KEY_A,
      id: "laptop-1",
    });
    expect(report.status).toBe("added");
    expect(host.text(AUTH)).toBe(`${OTHER_LINE}\n${KEY_A} homectl:laptop-1\n`);
    const file = host.files.get(AUTH);
    expect(file?.mode).toBe("0600");
    expect(file?.owner).toBe("oskar");
    expect(file?.group).toBe("oskar");
    expect(host.files.has(`${HOME}/.ssh/.authorized_keys.homectl-new`)).toBe(
      false,
    );
  });

  test("idempotent: a second add performs no writes", async () => {
    const host = new FakeHost();
    await addAuthorizedKey(host.exec, {
      ...target,
      publicKey: KEY_A,
      id: "laptop-1",
    });
    const before = host.text(AUTH);
    host.log.length = 0;
    const again = await addAuthorizedKey(host.exec, {
      ...target,
      publicKey: KEY_A,
      id: "laptop-1",
    });
    expect(again.status).toBe("unchanged");
    expect(writes(host)).toEqual([]);
    expect(host.text(AUTH)).toBe(before);
  });

  test("works without sudo for the calling account itself", async () => {
    const host = new FakeHost();
    const report = await addAuthorizedKey(host.exec, {
      user: "oskar",
      home: HOME,
      useSudo: false,
      publicKey: KEY_A,
      id: "self",
    });
    expect(report.status).toBe("added");
    expect(host.log.some((entry) => entry.argv[0] === "sudo")).toBe(false);
  });

  test("a symlinked authorized_keys is refused and never edited", async () => {
    const host = new FakeHost();
    host.put(AUTH, "", { link: "/srv/cluster/keys" });
    host.put("/srv/cluster/keys", `${OTHER_LINE}\n`);
    const report = await addAuthorizedKey(host.exec, {
      ...target,
      publicKey: KEY_A,
      id: "x",
    });
    expect(report.status).toBe("refused");
    expect(report.reason).toBe(
      "symlinked authorized_keys; review cluster-wide effect",
    );
    expect(writes(host)).toEqual([]);
    expect(host.text("/srv/cluster/keys")).toBe(`${OTHER_LINE}\n`);
  });

  test("a symlinked .ssh directory is refused", async () => {
    const host = new FakeHost();
    host.put(`${HOME}/.ssh`, "", { link: "/srv/ssh" });
    const report = await addAuthorizedKey(host.exec, {
      ...target,
      publicKey: KEY_A,
      id: "x",
    });
    expect(report.status).toBe("refused");
    expect(writes(host)).toEqual([]);
  });

  test("creates the .ssh directory with 0700 when it is missing", async () => {
    const host = new FakeHost();
    host.dirs.delete(`${HOME}/.ssh`);
    const report = await addAuthorizedKey(host.exec, {
      ...target,
      publicKey: KEY_A,
      id: "x",
    });
    expect(report.status).toBe("added");
    expect(host.dirs.has(`${HOME}/.ssh`)).toBe(true);
    expect(
      host.log.some(
        (entry) => entry.argv.includes("-d") && entry.argv.includes("0700"),
      ),
    ).toBe(true);
  });

  test("a failed rename leaves the previous file untouched", async () => {
    const host = new FakeHost();
    host.put(AUTH, `${OTHER_LINE}\n`, {
      owner: "oskar",
      group: "oskar",
      mode: "0600",
    });
    host.failIf = (argv) => argv.includes("mv");
    const report = await addAuthorizedKey(host.exec, {
      ...target,
      publicKey: KEY_A,
      id: "x",
    });
    expect(report.status).toBe("failed");
    expect(host.text(AUTH)).toBe(`${OTHER_LINE}\n`);
    expect(host.files.has(`${HOME}/.ssh/.authorized_keys.homectl-new`)).toBe(
      false,
    );
  });

  test("keys with an options prefix, newlines or a forged tag are refused", async () => {
    const host = new FakeHost();
    const bad = [
      `command="/bin/true" ${KEY_A}`,
      `${KEY_A}\nssh-rsa AAAA extra`,
      `${KEY_A} homectl:other`,
      "ssh-dss AAAAB3NzaC1kc3M=",
      `${KEY_A}\0`,
    ];
    for (const publicKey of bad)
      await expect(
        addAuthorizedKey(host.exec, { ...target, publicKey, id: "x" }),
      ).rejects.toThrow(HomectlError);
    expect(writes(host)).toEqual([]);
  });

  test("root and unsafe home paths are refused", async () => {
    const host = new FakeHost();
    await expect(
      addAuthorizedKey(host.exec, {
        user: "root",
        home: "/root",
        useSudo: true,
        publicKey: KEY_A,
        id: "x",
      }),
    ).rejects.toThrow(HomectlError);
    await expect(
      addAuthorizedKey(host.exec, {
        user: "oskar",
        home: "/home/../etc",
        useSudo: true,
        publicKey: KEY_A,
        id: "x",
      }),
    ).rejects.toThrow(HomectlError);
  });
});

describe("removeAuthorizedKey", () => {
  test("removes only the homectl-tagged line for that id", async () => {
    const host = new FakeHost();
    host.put(AUTH, `${OTHER_LINE}\n${KEY_A} homectl:x\n${KEY_B} homectl:y\n`, {
      owner: "oskar",
      group: "oskar",
      mode: "0600",
    });
    const report = await removeAuthorizedKey(host.exec, { ...target, id: "x" });
    expect(report.status).toBe("removed");
    expect(host.text(AUTH)).toBe(`${OTHER_LINE}\n${KEY_B} homectl:y\n`);
  });

  test("never removes an untagged key with the same material", async () => {
    const host = new FakeHost();
    host.put(AUTH, `${KEY_A}\n`, {
      owner: "oskar",
      group: "oskar",
      mode: "0600",
    });
    const report = await removeAuthorizedKey(host.exec, { ...target, id: "x" });
    expect(report.status).toBe("unchanged");
    expect(host.text(AUTH)).toBe(`${KEY_A}\n`);
  });

  test("a missing file is a no-op and a symlink is refused", async () => {
    const host = new FakeHost();
    expect(
      (await removeAuthorizedKey(host.exec, { ...target, id: "x" })).status,
    ).toBe("unchanged");
    host.put(AUTH, "", { link: "/srv/keys" });
    expect(
      (await removeAuthorizedKey(host.exec, { ...target, id: "x" })).status,
    ).toBe("refused");
    expect(writes(host)).toEqual([]);
  });
});
