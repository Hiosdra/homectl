// Named rollback branches of applyGrant (src/hostperm/apply.ts): the installed
// configuration that visudo rejects, and the installed configuration in which
// sudo cannot list the user's rules. Each must put the previous drop-in back.
import { describe, expect, test } from "bun:test";
import { applyGrant, planGrant, renderDropIn } from "../src/hostperm";
import { FakeHost } from "./hostperm-fake-remote";

const PATH = "/etc/sudoers.d/homectl-oskar";
const BAK = "/etc/sudoers.d/.homectl-oskar.bak";

function grant(id: string): string {
  return renderDropIn(
    "oskar",
    { kind: "allow", argv: [["/usr/bin/systemctl", "status", "sshd"]] },
    id,
  );
}

// Fails the first whole-configuration check (visudo -c) only, so the
// rollback's own check still passes.
function failFirstWholeCheck(host: FakeHost): void {
  let tripped = false;
  host.failIf = (argv) => {
    if (tripped || !argv.includes("visudo") || !argv.includes("-c"))
      return false;
    tripped = true;
    return true;
  };
}

describe("applyGrant rollback branches", () => {
  test("visudo rejecting the installed configuration restores the previous drop-in", async () => {
    const host = new FakeHost();
    host.put(PATH, grant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", grant("new-id"));
    failFirstWholeCheck(host);

    const report = await applyGrant(host.exec, plan);

    expect(report.status).toBe("rolled-back");
    expect(report.reason).toBe(
      "visudo rejected the installed configuration; previous state restored",
    );
    expect(host.text(PATH)).toBe(grant("old-id"));
    expect(host.files.get(PATH)?.mode).toBe("0440");
    expect(host.text(BAK)).toBeUndefined();
    expect(report.steps.map((step) => step.id)).toContain("restore-backup");
  });

  test("a sudo listing failure after install restores the previous drop-in", async () => {
    const host = new FakeHost();
    host.put(PATH, grant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", grant("new-id"));
    host.failIf = (argv) => argv.includes("-l");

    const report = await applyGrant(host.exec, plan);

    expect(report.status).toBe("rolled-back");
    expect(report.reason).toBe(
      "sudo could not list the user's privileges; previous state restored",
    );
    expect(host.text(PATH)).toBe(grant("old-id"));
    expect(host.text(BAK)).toBeUndefined();
  });

  test("a sudo listing failure on a fresh host removes the new drop-in", async () => {
    const host = new FakeHost();
    const plan = await planGrant(host.exec, "oskar", grant("new-id"));
    host.failIf = (argv) => argv.includes("-l");

    const report = await applyGrant(host.exec, plan);

    expect(report.status).toBe("rolled-back");
    expect(report.steps.map((step) => step.id)).toContain("remove-new");
    expect(host.text(PATH)).toBeUndefined();
  });

  test("a rollback whose own visudo check fails is reported, never as rolled back", async () => {
    const host = new FakeHost();
    host.put(PATH, grant("old-id"), { mode: "0440" });
    const plan = await planGrant(host.exec, "oskar", grant("new-id"));
    host.failIf = (argv) => argv.includes("visudo") && argv.includes("-c");

    const report = await applyGrant(host.exec, plan);

    expect(report.status).toBe("restore-failed");
    expect(report.reason).toContain("review");
  });
});
