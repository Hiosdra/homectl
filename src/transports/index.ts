import { HomectlError, type Machine, type ProcessSpec } from "../types";
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function sshConfig(machines: Record<string, Machine>) {
  return Object.values(machines)
    .filter((m) => m.transport === "ssh")
    .map(
      (m) =>
        `Host ${m.ssh_alias}\n  HostName ${m.address}\n  User ${m.user}\n  Port ${m.port ?? 22}\n  StrictHostKeyChecking yes\n  ForwardAgent no\n  ConnectTimeout 10\n  ServerAliveInterval 15\n  ServerAliveCountMax 2\n${m.auth?.type === "keepassxc" ? `  IdentityAgent ${configQuote(m.auth.socket ?? "")}\n  IdentityFile ${configQuote(m.auth.public_key ?? "")}\n  IdentitiesOnly yes\n  PreferredAuthentications publickey\n  PasswordAuthentication no\n` : ""}`,
    )
    .join("\n");
}
function configQuote(value: string) {
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
      "ssh",
      "-F",
      configPath,
      "-T",
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
