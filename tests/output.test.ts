import { expect, test } from "bun:test";
import { formatError, formatHuman } from "../src/cli/output";

test("human doctor shows actionable failures", () => {
  const output = formatHuman(
    {
      ok: false,
      checks: [
        { name: "ssh", ok: false, remediation: "Enable OpenSSH Client" },
        { name: "bun", ok: true },
      ],
    },
    "doctor",
  );
  expect(output).toContain("FAIL  ssh");
  expect(output).toContain("Enable OpenSSH Client");
  expect(output).toContain("OK  bun");
  expect(output).not.toContain('"checks"');
});
test("execution prints command output rather than escaping it", () => {
  expect(
    formatHuman(
      { result: { stdout: "line one\nline two\n", stderr: "", exitCode: 0 } },
      "exec",
    ),
  ).toBe("line one\nline two\nExit code: 0");
});
test("nested dry-run retains approval and arguments without JSON syntax", () => {
  const output = formatHuman({
    plan: { approval: "approval-digest", argv: ["uname", "-a"] },
  });
  expect(output).toContain("Approval: approval-digest");
  expect(output).toContain("• uname");
});
test("errors keep exit code and approval details", () => {
  expect(formatError("Approval required", 4, { approval: "digest" })).toContain(
    "Approval: digest",
  );
});
