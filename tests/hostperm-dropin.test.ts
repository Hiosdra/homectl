import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyGrant,
  detectDrift,
  managedContent,
  parseManaged,
  planGrant,
  renderDropIn,
  revokeGrant,
} from "../src/hostperm";
import { HomectlError } from "../src/types";
import { FakeHost } from "./hostperm-fake-remote";

const PATH = "/etc/sudoers.d/homectl-oskar";
const TMP = "/etc/sudoers.d/.homectl-oskar.new";
const BAK = "/etc/sudoers.d/.homectl-oskar.bak";
const SSHD_GRANT = [["/usr/bin/systemctl", "status", "sshd"]];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function desiredGrant(id = "restart-sshd"): string {
  return renderDropIn("oskar", { kind: "allow", argv: SSHD_GRANT }, id);
}

function visudoCheckCalls(host: FakeHost): number {
  return host.log.filter(
    (entry) => entry.argv.includes("visudo") && entry.argv.includes("-c"),
  ).length;
}

describe("renderDropIn", () => {
  test("first line is the homectl header with the body hash", () => {
    const content = renderDropIn("oskar", { kind: "full" }, "grant-a");
    const [first, ...rest] = content.split("\n");
    const body = rest.join("\n");
    expect(first).toBe(`# homectl-managed id=grant-a sha256=${sha256(body)}`);
    expect(body).toBe("oskar ALL=(ALL:ALL) NOPASSWD: ALL\n");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("allow grants render literal absolute argv only", () => {
    const content = renderDropIn(
      "oskar",
      { kind: "allow", argv: SSHD_GRANT },
      "restart-sshd",
    );
    expect(parseManaged(content)?.body).toBe(
      "oskar ALL=(root) NOPASSWD: /usr/bin/systemctl status sshd\n",
    );
  });

  test("the literal rules of policies.sudoers() are enforced", () => {
    const bad: string[][][] = [
      [["systemctl", "status"]],
      [["/usr/bin/systemctl", "st*"]],
      [["/usr/bin/x", "a\nb"]],
      [["/usr/bin/x", "a,b"]],
      [],
      [[]],
    ];
    for (const argv of bad)
      expect(() =>
        renderDropIn("oskar", { kind: "allow", argv }, "grant-a"),
      ).toThrow(HomectlError);
  });

  test("root, dotted names and invalid ids are refused", () => {
    expect(() => renderDropIn("root", { kind: "full" }, "grant-a")).toThrow(
      HomectlError,
    );
    expect(() => renderDropIn("bad.name", { kind: "full" }, "grant-a")).toThrow(
      HomectlError,
    );
    expect(() => renderDropIn("oskar", { kind: "full" }, "Bad_Id")).toThrow(
      HomectlError,
    );
  });
});

describe("planGrant", () => {
  test("fresh host: absent file, all-added diff, nothing written", async () => {
    const host = new FakeHost();
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    expect(plan.path).toBe(PATH);
    expect(plan.current).toBeUndefined();
    expect(plan.changed).toBe(true);
    expect(plan.foreign).toBe(false);
    expect(plan.diff.split("\n").every((line) => line.startsWith("+ "))).toBe(
      true,
    );
    expect(plan.desiredSha256).toBe(sha256(desiredGrant()));
    const writes = ["install", "mv", "cp", "rm", "useradd"];
    expect(
      host.log.some((entry) => writes.some((w) => entry.argv.includes(w))),
    ).toBe(false);
    expect(host.text(PATH)).toBeUndefined();
  });

  test("existing managed file: diff shows only the lines that differ", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), {
      owner: "root",
      group: "root",
      mode: "0440",
    });
    const relabelled = await planGrant(
      host.exec,
      "oskar",
      desiredGrant("new-id"),
    );
    expect(relabelled.changed).toBe(true);
    expect(relabelled.diff).toContain("- # homectl-managed id=old-id");
    expect(relabelled.diff).toContain("+ # homectl-managed id=new-id");
    expect(relabelled.diff).not.toContain("NOPASSWD");

    const widened = renderDropIn(
      "oskar",
      { kind: "allow", argv: [["/usr/bin/true"]] },
      "old-id",
    );
    const body = await planGrant(host.exec, "oskar", widened);
    expect(body.diff).toContain(
      "- oskar ALL=(root) NOPASSWD: /usr/bin/systemctl status sshd",
    );
    expect(body.diff).toContain("+ oskar ALL=(root) NOPASSWD: /usr/bin/true");
  });

  test("identical content is not a change", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant(), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    expect(plan.changed).toBe(false);
  });

  test("a file without a homectl header is flagged foreign", async () => {
    const host = new FakeHost();
    host.put(PATH, "oskar ALL=(ALL) ALL\n");
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    expect(plan.foreign).toBe(true);
    expect(plan.current).toBe("oskar ALL=(ALL) ALL\n");
  });

  test("desired content without a valid header is refused", async () => {
    const host = new FakeHost();
    await expect(
      planGrant(host.exec, "oskar", "oskar ALL=(ALL) ALL\n"),
    ).rejects.toThrow(HomectlError);
    const tampered = managedContent("grant-a", "body\n").replace(
      "body",
      "other",
    );
    await expect(planGrant(host.exec, "oskar", tampered)).rejects.toThrow(
      HomectlError,
    );
  });

  test("a live file that cannot be read is an error, not an assumed absence", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant());
    host.sudoWorks = false;
    await expect(
      planGrant(host.exec, "oskar", desiredGrant()),
    ).rejects.toThrow();
  });
});

describe("applyGrant", () => {
  test("success: exact argv sequence, content only on stdin, owner root 0440", async () => {
    const host = new FakeHost();
    const desired = desiredGrant();
    const plan = await planGrant(host.exec, "oskar", desired);
    host.log.length = 0;
    const report = await applyGrant(host.exec, plan);

    expect(report.status).toBe("applied");
    expect(report.steps.map((step) => step.argv)).toEqual([
      ["sudo", "-n", "cat", PATH],
      [
        "sudo",
        "-n",
        "install",
        "-m",
        "0440",
        "-o",
        "root",
        "-g",
        "root",
        "/dev/stdin",
        TMP,
      ],
      ["sudo", "-n", "visudo", "-cf", TMP],
      ["sudo", "-n", "mv", "-f", TMP, PATH],
      ["sudo", "-n", "visudo", "-c"],
      ["sudo", "-n", "sha256sum", PATH],
      ["sudo", "-n", "-l", "-U", "oskar"],
    ]);
    expect(host.text(PATH)).toBe(desired);
    const installed = host.files.get(PATH);
    expect(installed?.mode).toBe("0440");
    expect(installed?.owner).toBe("root");
    expect(host.files.has(TMP)).toBe(false);
    expect(host.files.has(BAK)).toBe(false);
  });

  test("no command argv contains the desired content", async () => {
    const host = new FakeHost();
    const desired = desiredGrant();
    const plan = await planGrant(host.exec, "oskar", desired);
    host.log.length = 0;
    await applyGrant(host.exec, plan);
    for (const entry of host.log) {
      for (const arg of entry.argv) expect(arg).not.toContain("NOPASSWD");
    }
    expect(host.log.find((entry) => entry.stdin !== undefined)?.stdin).toBe(
      desired,
    );
  });

  test("replacing a managed file keeps a backup until success, then removes it", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant("new-id"));
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("applied");
    expect(report.steps.map((step) => step.id)).toContain("backup-current");
    expect(host.text(PATH)).toBe(desiredGrant("new-id"));
    expect(host.files.has(BAK)).toBe(false);
  });

  test("candidate that fails visudo -cf leaves the live file untouched", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), { mode: "0440" });
    const broken = renderDropIn(
      "oskar",
      { kind: "allow", argv: [["/usr/bin/INVALID"]] },
      "grant-a",
    );
    const plan = await planGrant(host.exec, "oskar", broken);
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("failed-untouched");
    expect(host.text(PATH)).toBe(desiredGrant("old-id"));
    expect(host.files.has(TMP)).toBe(false);
    expect(report.steps.map((step) => step.id)).not.toContain("swap");
  });

  test("final visudo -c failure restores the backup and its mode", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), {
      mode: "0440",
      owner: "root",
      group: "root",
    });
    const plan = await planGrant(host.exec, "oskar", desiredGrant("new-id"));
    let calls = 0;
    host.failIf = (argv) => {
      if (argv.includes("visudo") && argv.includes("-c")) return ++calls === 1;
      return false;
    };
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("rolled-back");
    expect(report.steps.map((step) => step.id)).toContain("restore-backup");
    expect(host.text(PATH)).toBe(desiredGrant("old-id"));
    expect(host.files.get(PATH)?.mode).toBe("0440");
    expect(host.files.has(BAK)).toBe(false);
  });

  test("final visudo -c failure on a fresh host removes the new file", async () => {
    const host = new FakeHost();
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    let calls = 0;
    host.failIf = (argv) =>
      argv.includes("visudo") && argv.includes("-c") && ++calls === 1;
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("rolled-back");
    expect(host.files.has(PATH)).toBe(false);
  });

  test("a failed restore is reported as restore-failed, never as success", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant("new-id"));
    host.failIf = (argv) => argv.includes("visudo") && argv.includes("-c");
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("restore-failed");
    expect(report.reason).toContain("manually");
  });

  test("a hash mismatch after install is rolled back", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant("new-id"));
    host.failIf = (argv) => argv[2] === "sha256sum";
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("rolled-back");
    expect(host.text(PATH)).toBe(desiredGrant("old-id"));
  });

  test("drift between preview and apply aborts before any write", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant("new-id"));
    host.put(PATH, desiredGrant("someone-else"), { mode: "0440" });
    host.log.length = 0;
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("refused");
    expect(report.reason).toContain("drift");
    expect(host.log.some((entry) => entry.argv.includes("install"))).toBe(
      false,
    );
    expect(host.text(PATH)).toBe(desiredGrant("someone-else"));
  });

  test("expectedCurrent that differs from the live file is refused as drift", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant("new-id"));
    const report = await applyGrant(host.exec, plan, {
      expectedCurrent: "other\n",
    });
    expect(report.status).toBe("refused");
  });

  test("a foreign file is refused and never overwritten", async () => {
    const host = new FakeHost();
    host.put(PATH, "oskar ALL=(ALL) ALL\n");
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    host.log.length = 0;
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("refused");
    expect(host.log.length).toBe(0);
    expect(host.text(PATH)).toBe("oskar ALL=(ALL) ALL\n");
  });

  test("a file that becomes foreign after preview is refused", async () => {
    const host = new FakeHost();
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    host.put(PATH, "oskar ALL=(ALL) ALL\n");
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("refused");
    expect(host.text(PATH)).toBe("oskar ALL=(ALL) ALL\n");
  });

  test("unchanged plan performs no writes", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant(), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    host.log.length = 0;
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("unchanged");
    expect(report.steps.map((step) => step.id)).toEqual(["reread"]);
  });

  test("an unchanged preview refuses subsequent drift", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant(), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    host.put(PATH, desiredGrant("changed"), { mode: "0440" });
    const report = await applyGrant(host.exec, plan);
    expect(report.status).toBe("refused");
    expect(report.reason).toContain("drift");
    expect(host.text(PATH)).toBe(desiredGrant("changed"));
  });

  test("a disconnect during the swap preserves the backup for inspection", async () => {
    const host = new FakeHost();
    const previous = desiredGrant("old-id");
    host.put(PATH, previous, { mode: "0440" });
    const desired = desiredGrant("new-id");
    const plan = await planGrant(host.exec, "oskar", desired);
    const report = await applyGrant(async (argv, options) => {
      const result = await host.exec(argv, options);
      if (argv[2] === "mv" && argv.at(-1) === PATH)
        throw new Error("connection lost");
      return result;
    }, plan);
    expect(report.status).toBe("outcome-unknown");
    expect(host.text(PATH)).toBe(desired);
    expect(host.text("/etc/sudoers.d/.homectl-oskar.bak")).toBe(previous);
  });

  test("a plan for another path is rejected", async () => {
    const host = new FakeHost();
    const plan = await planGrant(host.exec, "oskar", desiredGrant());
    await expect(
      applyGrant(host.exec, { ...plan, path: "/etc/sudoers" }),
    ).rejects.toThrow(HomectlError);
  });
});

describe("revokeGrant", () => {
  test("removes a managed drop-in and its backup, verifies absence", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant(), { mode: "0440" });
    const report = await revokeGrant(host.exec, "oskar");
    expect(report.status).toBe("removed");
    expect(host.files.has(PATH)).toBe(false);
    expect(host.files.has(BAK)).toBe(false);
  });

  test("never removes a file without the homectl header", async () => {
    const host = new FakeHost();
    host.put(PATH, "oskar ALL=(ALL) ALL\n");
    const report = await revokeGrant(host.exec, "oskar");
    expect(report.status).toBe("refused");
    expect(host.text(PATH)).toBe("oskar ALL=(ALL) ALL\n");
    expect(host.log.some((entry) => entry.argv.includes("rm"))).toBe(false);
  });

  test("absent drop-in is a no-op", async () => {
    const host = new FakeHost();
    const report = await revokeGrant(host.exec, "oskar");
    expect(report.status).toBe("absent");
    expect(host.log.some((entry) => entry.argv.includes("rm"))).toBe(false);
  });

  test("a modified managed file is removed and the report says so", async () => {
    const host = new FakeHost();
    host.put(
      PATH,
      `# homectl-managed id=grant-a sha256=${"0".repeat(64)}\nedited\n`,
    );
    const report = await revokeGrant(host.exec, "oskar");
    expect(report.status).toBe("removed");
    expect(report.reason).toContain("modified");
  });

  test("when visudo fails after removal, the drop-in is restored", async () => {
    const host = new FakeHost();
    host.put(PATH, desiredGrant(), { mode: "0440" });
    let calls = 0;
    host.failIf = (argv) =>
      argv.includes("visudo") && argv.includes("-c") && ++calls === 1;
    const report = await revokeGrant(host.exec, "oskar");
    expect(report.status).toBe("rolled-back");
    expect(host.text(PATH)).toBe(desiredGrant());
    expect(host.files.get(PATH)?.mode).toBe("0440");
    expect(visudoCheckCalls(host)).toBe(2);
  });
});

describe("detectDrift", () => {
  test("absent, match, modified, foreign and recorded-hash mismatch", async () => {
    const host = new FakeHost();
    expect(await detectDrift(host.exec, "oskar")).toBe("absent");
    host.put(PATH, desiredGrant());
    const body = parseManaged(desiredGrant())?.body ?? "";
    expect(await detectDrift(host.exec, "oskar")).toBe("match");
    expect(await detectDrift(host.exec, "oskar", sha256(body))).toBe("match");
    expect(await detectDrift(host.exec, "oskar", "f".repeat(64))).toBe(
      "modified",
    );
    host.put(
      PATH,
      `# homectl-managed id=grant-a sha256=${"0".repeat(64)}\nedited\n`,
    );
    expect(await detectDrift(host.exec, "oskar")).toBe("modified");
    host.put(PATH, "oskar ALL=(ALL) ALL\n");
    expect(await detectDrift(host.exec, "oskar")).toBe("foreign");
  });
});
