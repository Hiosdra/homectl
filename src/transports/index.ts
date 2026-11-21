import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collectHostKeys } from "../peer/hostkeys";
import { executable, windows } from "../platform";
import { HomectlError, type Machine, type ProcessSpec } from "../types";
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function sshConfig(machines: Record<string, Machine>, known?: string) {
  return Object.values(machines)
    .filter((m) => m.transport === "ssh")
    .map(
      (m) =>
        `Host ${m.ssh_alias}\n  HostName ${m.address}\n  User ${m.user}\n  Port ${m.port ?? 22}\n  StrictHostKeyChecking yes\n${known && hasManagedKey(m, known) ? `  UserKnownHostsFile ${configQuote(known)}\n` : ""}  ForwardAgent no\n  ConnectTimeout 10\n  ServerAliveInterval 15\n  ServerAliveCountMax 2\n${m.auth?.type === "keepassxc" ? `  IdentityAgent ${configQuote(m.auth.socket ?? "")}\n  IdentityFile ${configQuote(m.auth.public_key ?? "")}\n  IdentitiesOnly yes\n  PreferredAuthentications publickey\n  PasswordAuthentication no\n` : ""}`,
    )
    .join("\n");
}
function hasManagedKey(machine: Machine, path: string) {
  try {
    return (
      Object.keys(
        collectHostKeys(readFileSync(path, "utf8"), { host: machine }),
      ).length > 0
    );
  } catch {
    return false;
  }
}
function configQuote(value: string) {
  if (windows) value = value.replaceAll("\\", "/");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
export function transportSpec(
  machine: Machine,
  argv: string[],
  configPath: string,
): ProcessSpec {
  if (machine.transport === "local") return { argv, timeoutMs: 120_000 };
  if (!machine.ssh_alias) throw new HomectlError(2, "Missing SSH alias");
  return {
    argv: [
      executable("ssh"),
      "-F",
      configPath,
      "-T",
      ...(hasManagedKey(machine, join(dirname(configPath), "known_hosts"))
        ? [
            "-o",
            `UserKnownHostsFile=${configQuote(join(dirname(configPath), "known_hosts"))}`,
          ]
        : []),
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "BatchMode=yes",
      machine.ssh_alias,
      argv.map(shellQuote).join(" "),
    ],
    timeoutMs: 120_000,
  };
}

// Owner-side inspection uses the exact inventory address and broker key. It
// does not load user/system SSH config or fall back to other host key stores.
export function trustedHostProbeSpec(
  machine: Machine,
  argv: string[],
  knownHosts: string,
): ProcessSpec {
  if (
    machine.transport !== "ssh" ||
    !machine.address ||
    !machine.user ||
    !machine.auth?.socket ||
    !machine.auth.public_key
  )
    throw new HomectlError(
      3,
      "Host inspection requires an SSH host with a broker-managed key",
    );
  return {
    argv: [
      executable("ssh"),
      "-F",
      "none",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "GlobalKnownHostsFile=none",
      "-o",
      `UserKnownHostsFile=${configQuote(knownHosts)}`,
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      `IdentityAgent=${configQuote(machine.auth.socket)}`,
      "-i",
      machine.auth.public_key,
      "-o",
      "ConnectTimeout=8",
      "-p",
      String(machine.port ?? 22),
      "-l",
      machine.user,
      "--",
      machine.address,
      argv.map(shellQuote).join(" "),
    ],
    timeoutMs: 10_000,
  };
}
