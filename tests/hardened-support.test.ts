// Hardened mode is reported per platform, and only Linux with systemd is supported.
import { expect, test } from "bun:test";
import { hardenedSupport } from "../src/broker/hardened-support";

test("hardened mode is supported only on Linux under systemd", () => {
  expect(hardenedSupport("linux", true).supported).toBe(true);
  expect(hardenedSupport("linux", true).statement).toContain("supported");
  expect(hardenedSupport("linux", false).supported).toBe(false);
  expect(hardenedSupport("linux", false).statement).toContain("needs systemd");
});

test("Windows and macOS say hardened mode is not available yet", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const support = hardenedSupport(platform, false);
    expect(support.supported).toBe(false);
    expect(support.statement).toContain("not available");
    expect(support.statement).toContain("Compatibility mode");
  }
});

test("unknown platforms are reported as unavailable, never as supported", () => {
  const support = hardenedSupport("freebsd", false);
  expect(support.supported).toBe(false);
  expect(support.statement).toContain("freebsd");
});
