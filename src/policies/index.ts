import { createHash } from "node:crypto";
import { basename } from "node:path";
import { type ExecutionPlan, HomectlError, type Machine } from "../types";

const destructive = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "mkfs",
  "wipefs",
  "fdisk",
  "sfdisk",
  "parted",
  "dd",
  "truncate",
  "userdel",
  "deluser",
  "dropdb",
  "lvremove",
  "vgremove",
  "pvremove",
  "zpool",
  "blkdiscard",
]);
const opaque = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "eval",
  "exec",
  "env",
  "xargs",
  "find",
  "awk",
  "sed",
  "perl",
  "python",
  "python3",
  "node",
  "bun",
  "ruby",
  "ssh",
  "scp",
  "rsync",
  "su",
  "doas",
  "pkexec",
  "chroot",
  "nsenter",
  "unshare",
  "busybox",
  "tee",
  "cp",
  "mv",
  "install",
  "curl",
  "wget",
]);
export function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function innerCommand(argv: string[]) {
  if (argv[0] === "sudo" || argv[0] === "/usr/bin/sudo") {
    if (argv[1] !== "-n" || argv.length < 3)
      throw new HomectlError(
        3,
        "Use sudo -n followed by exact command argv; other sudo options are unsupported",
      );
    return { sudo: true, args: argv.slice(2) };
  }
  return { sudo: false, args: argv };
}
function inspection(argv: string[]): boolean {
  const [cmd, ...a] = argv;
  if (
    !cmd ||
    argv.some((v) => v.includes("\r") || v.includes("\n") || v.includes("\0"))
  )
    return false;
  const name = basename(cmd);
  if (name === "hostname")
    return (
      a.length === 0 ||
      a.every((v) =>
        ["-f", "-s", "-d", "-i", "-I", "-A", "--fqdn", "--short"].includes(v),
      )
    );
  if (
    [
      "uptime",
      "whoami",
      "uname",
      "df",
      "free",
      "lsblk",
      "id",
      "pwd",
      "true",
    ].includes(name)
  )
    return a.every((v) => /^[-a-zA-Z0-9=.,/]+$/.test(v));
  if (name === "ls")
    return !a.some((v) =>
      v === "--" ? false : v.startsWith("-") && !/^-[lahd1]+$/.test(v),
    );
  if (name === "cat" || name === "head" || name === "tail")
    return (
      a.length > 0 &&
      a.every((v) => !v.startsWith("-") || /^-([ncf]?\d+|n|c|f)$/.test(v)) &&
      !a.includes("/proc/self/environ")
    );
  if (name === "systemctl")
    return (
      [
        "status",
        "is-active",
        "is-enabled",
        "show",
        "list-units",
        "list-unit-files",
      ].includes(a[0] ?? "") &&
      !a.some((v) => v.startsWith("--root") || v.startsWith("--image"))
    );
  if (name === "journalctl")
    return (
      a.every(
        (v) =>
          !/^--(vacuum|rotate|flush|sync|setup|relinquish|update|smart-relinquish)/.test(
            v,
          ),
      ) &&
      !a.includes("--") &&
      a.every(
        (v) =>
          !v.startsWith("-") ||
          /^(-[unbxeoqf]|--(no-pager|since|until|unit|boot|lines|output)(=|$))/.test(
            v,
          ),
      )
    );
  if (name === "docker")
    return [
      "ps",
      "images",
      "stats",
      "inspect",
      "logs",
      "version",
      "info",
    ].includes(a[0] ?? "");
  return false;
}
export function classify(argv: string[]): ExecutionPlan["classification"] {
  const { args } = innerCommand(argv);
  const [cmd, ...a] = args;
  const name = basename(cmd ?? "");
  const text = a.join(" ").toLowerCase();
  if (destructive.has(name) || name.startsWith("mkfs.")) return "destructive";
  if (
    ["docker", "podman", "nerdctl"].includes(name) &&
    a.some((v) => ["rm", "rmi", "prune", "remove"].includes(v))
  )
    return "destructive";
  if (
    ["qm", "pct"].includes(name) &&
    a.some((v) => ["destroy", "delsnapshot", "unlink", "rollback"].includes(v))
  )
    return "destructive";
  if (
    name === "zfs" &&
    a.some((v) => ["destroy", "rollback", "receive"].includes(v))
  )
    return "destructive";
  if (
    ["apt", "apt-get", "dpkg", "dnf", "yum", "pacman", "apk"].includes(name) &&
    /\b(remove|purge|autoremove|erase)\b/.test(text)
  )
    return "destructive";
  if (
    ["git", "redis-cli", "mysql", "psql", "sqlite3"].includes(name) &&
    /\b(reset|clean|drop|truncate|flushall|flushdb|delete)\b/.test(text)
  )
    return "destructive";
  if (
    ["apt", "apt-get"].includes(name) &&
    a.some(
      (v) => v.startsWith("-o") || v.startsWith("--option") || v.includes("::"),
    )
  )
    return "opaque";
  if (inspection(args)) return "inspect";
  if (
    opaque.has(name) ||
    name.includes(".") ||
    a.some((v) => v.includes("\r") || v.includes("\n") || v.includes("\0"))
  )
    return "opaque";
  if (
    ["apt", "apt-get"].includes(name) &&
    ["update", "upgrade", "full-upgrade", "install"].includes(a[0] ?? "")
  )
    return "mutation";
  if (
    name === "systemctl" &&
    [
      "restart",
      "start",
      "stop",
      "reload",
      "enable",
      "disable",
      "daemon-reload",
    ].includes(a[0] ?? "")
  )
    return "mutation";
  return "opaque";
}
export function planExecution(
  host: string,
  machine: Machine,
  argv: string[],
  impact?: string,
): ExecutionPlan {
  if (!argv.length || argv.some((v) => v.includes("\x00")))
    throw new HomectlError(
      2,
      "Command argv must be nonempty and contain no NUL",
    );
  const { sudo, args } = innerCommand(argv);
  const name = basename(args[0] ?? "");
  const classification = classify(argv);
  if (machine.access === "observe" && (sudo || classification !== "inspect"))
    throw new HomectlError(
      3,
      "Observe permits only supported inspection commands without sudo",
    );
  if (
    machine.access !== "full" &&
    ["su", "doas", "pkexec", "sudo", "chroot", "nsenter", "unshare"].includes(
      name,
    )
  )
    throw new HomectlError(
      3,
      "Privilege escalation is forbidden for this tier",
    );
  if (sudo && (machine.access === "user" || machine.access === "observe"))
    throw new HomectlError(3, "Sudo is forbidden for this tier");
  if (
    sudo &&
    machine.access === "sudo-approved" &&
    !machine.sudo_allow?.some((v) => JSON.stringify(v) === JSON.stringify(args))
  )
    throw new HomectlError(3, "Privileged argv is not exactly allowlisted");
  const needsApproval =
    classification === "destructive" || classification === "opaque";
  const affected =
    impact?.trim() ||
    `${host}: ${JSON.stringify(argv)} (inspect exact targets before approving)`;
  return {
    host,
    machine,
    argv,
    classification,
    impact: affected,
    needsApproval,
    approval: hash({ host, machine, argv, impact: affected }),
  };
}
export function checkApproval(plan: ExecutionPlan, approval?: string) {
  if (plan.needsApproval && approval !== plan.approval)
    throw new HomectlError(
      4,
      "Explicit user confirmation required for this exact operation",
      {
        host: plan.host,
        argv: plan.argv,
        impact: plan.impact,
        classification: plan.classification,
        approval: plan.approval,
      },
    );
}
export function sudoers(user: string, machine: Machine) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(user))
    throw new HomectlError(2, "Invalid existing user");
  if (user === "root")
    throw new HomectlError(
      2,
      "A root SSH account already has root authority; sudoers configuration is not applicable",
    );
  if (machine.access === "full") return `${user} ALL=(ALL:ALL) NOPASSWD: ALL\n`;
  if (machine.access !== "sudo-approved")
    throw new HomectlError(3, "Tier does not support sudoers");
  const entries = machine.sudo_allow ?? [];
  if (
    !entries.length ||
    entries.some(
      (a) =>
        !a[0]?.startsWith("/") || a.some((v) => !/^[a-zA-Z0-9/._=-]+$/.test(v)),
    )
  )
    throw new HomectlError(
      2,
      "Cannot render sudoers: only literal absolute executables and safe literal args are supported",
    );
  return `${user} ALL=(root) NOPASSWD: ${entries.map((a) => (a.length === 1 ? `${a[0]} ""` : a.join(" "))).join(", ")}\n`;
}
