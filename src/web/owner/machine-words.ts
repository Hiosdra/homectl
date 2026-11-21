// Plain words, input checks and the fingerprint rule for the owner panel's
// machines. Pure functions, so they test without a browser. The broker checks
// every value again; these checks only say what is wrong, in words the owner
// can act on.
import type {
  AccessTier,
  AssistantRef,
  MachineRow,
  ProbeInfo,
  ScanKey,
} from "./machine-api";
import { relativeTime } from "./time";

export const ACCESS_TIERS: {
  id: AccessTier;
  label: string;
  sentence: string;
}[] = [
  {
    id: "observe",
    label: "Look only",
    sentence:
      "It can check status and read files. It cannot change anything on the machine.",
  },
  {
    id: "user",
    label: "Everyday account",
    sentence:
      "It runs ordinary commands as this login. Changes wait for your approval by default.",
  },
  {
    id: "sudo-approved",
    label: "Admin with your approval",
    sentence:
      "It runs admin commands, but only the exact ones you list. Each one waits for your approval.",
  },
  {
    id: "full",
    label: "Full admin",
    sentence:
      "It has the account's full power, with no list to stay inside. Changes still wait for your approval by default.",
  },
];

export const ROOT_WARNING =
  "The root account always has full access. homectl sets Full admin for it, and it can do anything root can do on this machine. Use root only if you understand that.";

export function accessLabel(id: string): string {
  return ACCESS_TIERS.find((tier) => tier.id === id)?.label ?? id;
}

export function accessSentence(id: string): string {
  return ACCESS_TIERS.find((tier) => tier.id === id)?.sentence ?? "";
}

export function isRootLogin(login: string): boolean {
  return login.trim() === "root";
}

// Names read as the broker reads them: lowercase, a letter first, 63 at most.
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const LOGIN = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

export function nameProblem(name: string): string | undefined {
  if (name === "") return "Give the machine a name, such as nas or printer.";
  if (!NAME.test(name))
    return "Use lowercase letters, digits and hyphens, starting with a letter. For example: nas-office.";
  return undefined;
}

export function addressProblem(address: string): string | undefined {
  const value = address.trim();
  if (value === "")
    return "Enter the machine's address: an IP address or a host name.";
  if (/\s/.test(value)) return "The address must not contain spaces.";
  return undefined;
}

export function loginProblem(login: string): string | undefined {
  if (login.trim() === "")
    return "Enter the login name you use on that machine.";
  if (!LOGIN.test(login.trim()))
    return "The login name is one word of letters, digits, dots, dashes or underscores.";
  return undefined;
}

// One allowed command per line, split at spaces: "/usr/bin/systemctl restart nas".
export function parseCommandLines(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/));
}

export function commandProblem(commands: string[][]): string | undefined {
  if (commands.length === 0)
    return "Add at least one allowed command, one per line.";
  if (commands.some((command) => !command[0]?.startsWith("/")))
    return "Each allowed command starts with its full path, such as /usr/bin/systemctl.";
  return undefined;
}

// The owner's typed fingerprint must equal a presented key's fingerprint exactly
// (after trimming the ends). A revoked key never matches. Nothing is pinned here:
// enrolment pins, and the broker checks the same rule again.
export function fingerprintMatch(
  typed: string,
  keys: readonly ScanKey[],
): ScanKey | undefined {
  const value = typed.trim();
  if (value === "") return undefined;
  return keys.find((key) => key.fingerprint === value && !key.revoked);
}

export function identityWords(pinned: string | null): {
  label: string;
  tone: "good" | "neutral";
} {
  return pinned
    ? { label: "Identity checked", tone: "good" }
    : { label: "Not checked yet", tone: "neutral" };
}

// "5 minutes ago (Linux)", or the last failed attempt with its plain reason.
export function probeLine(probe: ProbeInfo | null, now = Date.now()): string {
  if (!probe) return "No check has run yet.";
  const worked =
    probe.okAt === undefined
      ? "No check has worked yet."
      : `Last check worked ${relativeTime(probe.okAt, now)}${probe.os ? ` (${probe.os})` : ""}.`;
  if (probe.ok) return worked;
  return `The last check failed ${relativeTime(probe.checkedAt, now)}: ${probe.reason ?? "unknown reason"} ${worked}`;
}

export function listOf(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function assistantLine(assistants: readonly AssistantRef[]): string {
  if (assistants.length === 0) return "No assistant can reach it yet.";
  return `${listOf(assistants.map((item) => item.name))} can reach it.`;
}

// The address as the owner types it, with the port when it is not 22.
export function addressLine(
  machine: Pick<MachineRow, "address" | "port">,
): string {
  return machine.port === 22
    ? machine.address
    : `${machine.address} · port ${machine.port}`;
}

// Details: the inventory fields and the tier id, in the order the owner reads them.
export function factsFor(machine: MachineRow): [string, string][] {
  return [
    ["Access level (id)", machine.access],
    ["Login name", machine.user || "None"],
    ["Pinned fingerprint", machine.pinned ?? "Not pinned yet"],
    ["Address", addressLine(machine)],
    ["Machine name (SSH alias)", machine.name],
    ["Allowed commands", machine.sudoAllow.join("; ") || "None"],
    ["Enforcement", machine.enforcement],
    ["Caution", machine.caution.join("; ") || "None"],
    ["Description", machine.description || "None"],
  ];
}

export function removalNote(assistants: number): string {
  const grants =
    assistants === 0
      ? "No assistant reached it."
      : `${assistants} ${assistants === 1 ? "assistant loses" : "assistants lose"} access to it.`;
  return `${grants} Its pinned identity is removed, so homectl will not connect to it again until you add it back.`;
}
