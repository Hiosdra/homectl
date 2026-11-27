// Hardened mode is reported per platform: Linux under systemd and Windows
// (virtual service account NT SERVICE\homectl) are supported; macOS is planned.
import { expect, test } from "bun:test";
import { hardenedSupport } from "../src/broker/hardened-support";

test("hardened mode is supported on Linux under systemd", () => {
  expect(hardenedSupport("linux", true).supported).toBe(true);
  expect(hardenedSupport("linux", true).statement).toContain("supported");
  expect(hardenedSupport("linux", false).supported).toBe(false);
  expect(hardenedSupport("linux", false).statement).toContain("needs systemd");
});

test("Windows reports hardened mode as supported with virtual service account", () => {
  const support = hardenedSupport("win32", false);
  expect(support.supported).toBe(true);
  expect(support.statement).toContain("NT SERVICE\\homectl");
});

test("macOS says hardened mode is not available yet", () => {
  const support = hardenedSupport("darwin", false);
  expect(support.supported).toBe(false);
  expect(support.statement).toContain("not available");
  expect(support.statement).toContain("Compatibility mode");
});

test("unknown platforms are reported as unavailable, never as supported", () => {
  const support = hardenedSupport("freebsd", false);
  expect(support.supported).toBe(false);
  expect(support.statement).toContain("freebsd");
});
