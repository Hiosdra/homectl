import { expect, test } from "bun:test";
import { interactivePair, pairingRole } from "../src/peer/interactive";

test("two discovered devices select complementary pairing roles regardless of arrival order", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  expect(pairingRole(first, second)).toBe("host");
  expect(pairingRole(second, first)).toBe("join");
});
test("interactive pairing refuses noninteractive execution before reading auth or starting a server", async () => {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  await expect(
    interactivePair("/missing/inventory.yaml", "/missing/ssh_config"),
  ).rejects.toThrow("private interactive terminal");
});
