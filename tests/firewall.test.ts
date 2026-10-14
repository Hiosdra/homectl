import { expect, test } from "bun:test";
import { firewallRules, selectedLAN } from "../src/firewall";

test("firewalld rules restrict source subnet, multicast destination and peer address", () => {
  const rules = firewallRules("192.168.1.0/24", "192.168.1.79");
  expect(rules[0]).toContain('source address="192.168.1.0/24"');
  expect(rules[0]).toContain('destination address="224.0.0.251"');
  expect(rules[0]).toContain('port="5353" protocol="udp"');
  expect(rules[1]).toContain('destination address="192.168.1.79"');
  expect(rules[1]).toContain('port="7448" protocol="tcp"');
});
test("firewall setup refuses wildcard, public and unassigned addresses", () => {
  for (const address of ["0.0.0.0", "8.8.8.8", "::", "192.168.254.254"])
    expect(() => selectedLAN(address)).toThrow();
});
