import { createHmac } from "node:crypto";
import { HomectlError, type Machine } from "../types";
export function hostAddress(machine: Machine) {
  return (machine.port ?? 22) === 22
    ? (machine.address ?? "")
    : `[${machine.address}]:${machine.port}`;
}
export function hostMatches(pattern: string, address: string) {
  if (pattern.startsWith("|1|")) {
    const [, , salt, value] = pattern.split("|");
    if (!salt || !value) return false;
    return (
      createHmac("sha1", Buffer.from(salt, "base64"))
        .update(address)
        .digest("base64") === value
    );
  }
  return pattern.split(",").includes(address);
}
export function collectHostKeys(
  text: string,
  machines: Record<string, Machine>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || line.startsWith("#") || f[0]?.startsWith("@")) continue;
    const [pattern, type, blob] = f;
    if (
      !pattern ||
      !type ||
      !blob ||
      !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(type) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)
    )
      continue;
    for (const m of Object.values(machines))
      if (
        m.transport === "ssh" &&
        (hostMatches(pattern, hostAddress(m)) ||
          hostMatches(pattern, m.ssh_alias ?? ""))
      ) {
        const host = hostAddress(m);
        const key = Buffer.from(`${host}:${type}`).toString("base64url");
        values[`hostkey:${key}`] = `${host} ${type} ${blob}`;
      }
  }
  return values;
}
export function validateHostKeys(
  values: Record<string, string>,
  machines: Record<string, Machine>,
) {
  for (const [id, line] of Object.entries(values)) {
    if (line.includes("\n") || line.includes("\r") || line.includes("\0"))
      throw new HomectlError(2, "Invalid trusted host key");
    const parsed = collectHostKeys(line, machines);
    if (parsed[id] !== line)
      throw new HomectlError(
        2,
        "Host key must refer to a synchronized host and exact key type",
      );
  }
}
