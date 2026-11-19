// Platform detection through native probes only. Unknown values are reported
// as limitations with a reason; nothing is inferred from vendor names.
import type { OsFamily, Platform, RemoteExec } from "./types";
import { sudo } from "./util";

// General distribution IDs whose account and sudoers tooling is well known.
// Vendor appliances are deliberately absent: they are treated as limited.
const KNOWN_IDS = new Set([
  "debian",
  "ubuntu",
  "fedora",
  "rhel",
  "centos",
  "rocky",
  "almalinux",
  "arch",
  "alpine",
  "opensuse-leap",
  "opensuse-tumbleweed",
  "sles",
  "amzn",
]);

const INCLUDE_PATTERN =
  "^[#@]includedir[[:space:]]+/etc/sudoers\\.d([[:space:]]|$)";

export interface OsRelease {
  id?: string;
  idLike: string[];
  versionId?: string;
}

export function parseOsRelease(text: string): OsRelease {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(raw.trim());
    if (!match) continue;
    const key = match[1] ?? "";
    let value = match[2] ?? "";
    if (value.length >= 2 && /^(["']).*\1$/.test(value))
      value = value.slice(1, -1);
    values.set(key, value);
  }
  return {
    id: values.get("ID") || undefined,
    idLike: (values.get("ID_LIKE") ?? "").split(/\s+/).filter(Boolean),
    versionId: values.get("VERSION_ID") || undefined,
  };
}

export function osFamily(unameKernel: string): OsFamily {
  switch (unameKernel.trim()) {
    case "Linux":
      return "linux";
    case "Darwin":
      return "darwin";
    case "FreeBSD":
      return "freebsd";
    default:
      return "unknown";
  }
}

export async function detectPlatform(exec: RemoteExec): Promise<Platform> {
  const release = await exec(["cat", "/etc/os-release"]);
  const uname = await exec(["uname", "-s", "-m"]);
  const uid = await exec(["id", "-u"]);
  const visudoProbe = await exec(["test", "-x", "/usr/sbin/visudo"]);
  const sudoersDProbe = await exec(["test", "-d", "/etc/sudoers.d"]);
  const useraddProbe = await exec(["test", "-x", "/usr/sbin/useradd"]);
  const sudoProbe = await exec(sudo(["true"]));

  const parsed = parseOsRelease(release.exitCode === 0 ? release.stdout : "");
  const os = osFamily(
    uname.exitCode === 0 ? (uname.stdout.split(/\s+/)[0] ?? "") : "",
  );
  const visudo = visudoProbe.exitCode === 0;
  const sudoersD = sudoersDProbe.exitCode === 0;
  const useradd = useraddProbe.exitCode === 0;
  const canSudo = sudoProbe.exitCode === 0;
  const isRoot = uid.exitCode === 0 && uid.stdout.trim() === "0";

  let sudoersInclude = false;
  let readOnlyEtc = false;
  if (canSudo) {
    const include = await exec(
      sudo(["grep", "-Eq", INCLUDE_PATTERN, "/etc/sudoers"]),
    );
    sudoersInclude = include.exitCode === 0;
    if (sudoersD) {
      const writable = await exec(sudo(["test", "-w", "/etc/sudoers.d"]));
      readOnlyEtc = writable.exitCode !== 0;
    }
  }

  const known =
    parsed.id !== undefined &&
    (KNOWN_IDS.has(parsed.id) ||
      parsed.idLike.some((value) => KNOWN_IDS.has(value)));
  const appliance = (os === "linux" && !known && !useradd) || readOnlyEtc;

  const reasons: string[] = [];
  if (os === "unknown")
    reasons.push("uname did not identify Linux, Darwin or FreeBSD; no grants");
  if (os === "linux" && !known)
    reasons.push(
      "os-release ID is missing or not recognised; dedicated accounts are disabled",
    );
  if (appliance && os === "linux" && !known && !useradd)
    reasons.push(
      "unrecognised system without useradd: treated as appliance (no new accounts)",
    );
  if (!visudo)
    reasons.push(
      "visudo not found at /usr/sbin/visudo; sudoers drop-ins unsupported",
    );
  if (!sudoersD)
    reasons.push("/etc/sudoers.d not present; sudoers drop-ins unsupported");
  if (!canSudo)
    reasons.push(
      "sudo -n is unavailable; privileged steps cannot run non-interactively",
    );
  else if (sudoersD && !sudoersInclude)
    reasons.push(
      "/etc/sudoers has no active includedir for /etc/sudoers.d; drop-ins would be ignored",
    );
  if (readOnlyEtc)
    reasons.push(
      "/etc/sudoers.d is not writable under sudo (read-only system files)",
    );

  const supports = {
    dropIns:
      os !== "unknown" &&
      visudo &&
      sudoersD &&
      sudoersInclude &&
      canSudo &&
      !readOnlyEtc,
    dedicatedAccount:
      os === "linux" && known && useradd && canSudo && !appliance,
    authorizedKeys: os !== "unknown" && canSudo,
  };

  return {
    os,
    id: parsed.id,
    versionId: parsed.versionId,
    visudo,
    sudoersD,
    sudoersInclude,
    canSudo,
    isRoot,
    useradd,
    readOnlyEtc,
    appliance,
    supports,
    reasons,
  };
}
