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
test("session status formats epoch timestamps for people", () => {
  const startedAt = 1794036470166;
  const expiresAt = 1794122870166;
  const formatDate = (timestamp: number) =>
    new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(timestamp));
  const output = formatHuman(
    { unlocked: true, startedAt, expiresAt, ttl: "24h" },
    "session",
    "status",
  );
  expect(output).toContain(`Started At: ${formatDate(startedAt)}`);
  expect(output).toContain(`Expires: ${formatDate(expiresAt)}`);
  expect(output).not.toContain(String(startedAt));
  expect(output).not.toContain(String(expiresAt));
});
test("session unlock formats epoch timestamps for people", () => {
  const startedAt = 1794036470166;
  const expiresAt = 1794122870166;
  const output = formatHuman(
    { unlocked: true, startedAt, expiresAt, syncUnlocked: true },
    "session",
    "unlock",
  );
  expect(output).toContain("Started At:");
  expect(output).toContain("Expires At:");
  expect(output).not.toContain(String(startedAt));
  expect(output).not.toContain(String(expiresAt));
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

test("completed update is a report, while dry-run remains a plan", () => {
  const output = formatHuman(
    {
      updated: false,
      revision: "1234567890",
      actions: ["Dependencies verified"],
      next: "Restart",
    },
    "update",
  );
  expect(output).toContain("✓ Dependencies verified");
  expect(output).not.toContain("Updated: No");
  expect(output).not.toContain("Restart");
  expect(
    formatHuman({ actions: ["Install dependencies"] }, "update"),
  ).toContain("Update preview");
});
