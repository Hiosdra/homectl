// Input checks and the probe record for the owner panel's machines (0.3 guided
// setup). Every value is checked before it reaches ssh or the inventory; a bad
// value gets a plain sentence, never the raw input echoed back.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../control/file-lock";
import { atomicReplace, protect } from "../platform";
import { type Access, HomectlError } from "../types";

export const ACCESS_TIERS: readonly Access[] = [
  "observe",
  "user",
  "sudo-approved",
  "full",
];

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const HOST_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const LOGIN = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_SUDO_COMMANDS = 20;
const MAX_SUDO_TOKENS = 12;

export function checkName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value))
    throw new HomectlError(
      2,
      "Use a name with 1 to 63 lowercase letters, digits or hyphens, starting with a letter.",
    );
  return value;
}

export function checkAddress(value: unknown): string {
  if (typeof value !== "string")
    throw new HomectlError(2, "Enter the machine's address (IP or host name).");
  const address = value.trim();
  const isName = address.length <= 253 && HOST_NAME.test(address);
  const isIp = address.includes(":") && IPV6.test(address);
  if (!isName && !isIp)
    throw new HomectlError(
      2,
      "The address must be an IP address or a host name, with no spaces.",
    );
  return address;
}

export function checkPort(value: unknown): number {
  if (value === undefined || value === null || value === "") return 22;
  const port = typeof value === "string" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1)
    throw new HomectlError(2, "The SSH port must be a number from 1 to 65535.");
  if (port > 65535)
    throw new HomectlError(2, "The SSH port must be a number from 1 to 65535.");
  return port;
}

export function checkLogin(value: unknown): string {
  if (typeof value !== "string" || !LOGIN.test(value))
    throw new HomectlError(
      2,
      "The login name must be one word of letters, digits, dots, dashes or underscores.",
    );
  return value;
}

export function checkAccess(value: unknown): Access {
  if (!ACCESS_TIERS.includes(value as Access))
    throw new HomectlError(
      2,
      "Choose an access level: look only, everyday account, admin with your approval, or full admin.",
    );
  return value as Access;
}

export function checkFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT.test(value.trim()))
    throw new HomectlError(
      2,
      "Type the fingerprint exactly as the machine shows it (it starts with SHA256:).",
    );
  return value.trim();
}

// The commands an admin-with-approval may run: exact argv lists, each starting
// with an absolute path. Undefined when none were given.
export function checkSudoAllow(
  value: unknown,
  access: Access,
): string[][] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw new HomectlError(2, "The allowed commands must be a list.");
  if (value.length === 0) return undefined;
  if (access !== "sudo-approved")
    throw new HomectlError(
      2,
      "Allowed commands apply only to Admin with your approval.",
    );
  if (value.length > MAX_SUDO_COMMANDS)
    throw new HomectlError(
      2,
      `Allow at most ${MAX_SUDO_COMMANDS} commands here.`,
    );
  return value.map((command) => {
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.length > MAX_SUDO_TOKENS ||
      command.some(
        (token) =>
          typeof token !== "string" ||
          token.length === 0 ||
          token.length > 256 ||
          /[\r\n\0]/.test(token),
      )
    )
      throw new HomectlError(
        2,
        "Each allowed command needs its full path, such as /usr/bin/systemctl, and its arguments.",
      );
    return [...command] as string[];
  });
}

// Probe results for each machine: the last attempt, and the last successful
// check. Plain facts only (a time, an OS name, a plain reason). Kept in the
// broker's state directory; no key material.
export interface ProbeRecord {
  checkedAt: number;
  ok: boolean;
  os?: string;
  okAt?: number;
  reason?: string;
}

export class ProbeStore {
  private readonly path: string;
  constructor(state: string) {
    this.path = join(state, "machine-probes.json");
  }

  async load(): Promise<Record<string, ProbeRecord>> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, ProbeRecord>)
        : {};
    } catch {
      return {};
    }
  }

  async set(name: string, record: ProbeRecord | undefined): Promise<void> {
    await withFileLock(`${this.path}.lock`, "Machine checks", async () => {
      const current = await this.load();
      if (record === undefined) delete current[name];
      else current[name] = record;
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(current), {
        mode: 0o600,
        flag: "wx",
      });
      await protect(temp);
      await atomicReplace(temp, this.path);
    });
  }
}
