// Host key trust through the broker (homelab #21 H31/C1). A scan only shows
// what the network presented and is never trusted by itself. The owner pins
// a key by typing the SHA256 fingerprint they verified out of band (console,
// provider panel); the broker rescans and pins only the key with exactly that
// fingerprint. An address that already has a different pinned key, or a key
// listed as @revoked, is refused: replacing trust is a separate, manual
// decision.
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../control/file-lock";
import { collectHostKeys, hostAddress } from "../peer/hostkeys";
import { atomicReplace, executable } from "../platform";
import { run } from "../process";
import { HomectlError, type Machine, type Runner } from "../types";
import type { RouteExtension } from "./server";
import type { EventsPort, InventoryPort } from "./types";

const KEY_TYPE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/;
const BLOB = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ScannedKey {
  type: string;
  blob: string;
  fingerprint: string;
}

// OpenSSH's SHA256 fingerprint: unpadded base64 of the key blob's digest.
export function keyFingerprint(blob: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(blob, "base64"))
    .digest("base64")
    .replace(/=+$/, "");
  return `SHA256:${digest}`;
}

export function parseKeyscan(output: string): ScannedKey[] {
  const keys = new Map<string, ScannedKey>();
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const [, type, blob] = line.trim().split(/\s+/);
    if (!type || !blob || !KEY_TYPE.test(type) || !BLOB.test(blob)) continue;
    keys.set(`${type} ${blob}`, {
      type,
      blob,
      fingerprint: keyFingerprint(blob),
    });
  }
  return [...keys.values()];
}

export function revokedBlobs(text: string): Set<string> {
  const blobs = new Set<string>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "@revoked" && fields[3]) blobs.add(fields[3]);
  }
  return blobs;
}

export class HostKeyRoutes implements RouteExtension {
  constructor(
    private readonly inventory: InventoryPort,
    private readonly inventoryPath: string,
    private readonly runner: Runner = run,
    private readonly events?: EventsPort,
  ) {}

  private get knownHosts() {
    return join(dirname(this.inventoryPath), "known_hosts");
  }

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    const pin = path === "/v1/owner/hosts/pin-key";
    if (path !== "/v1/owner/hosts/scan-keys" && !pin) return undefined;
    const host = input.host;
    if (
      typeof host !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(host)
    )
      throw new HomectlError(2, "A valid inventory host is required");
    const expected = input.fingerprint;
    if (
      pin &&
      (typeof expected !== "string" ||
        !/^SHA256:[A-Za-z0-9+/]{43}$/.test(expected))
    )
      throw new HomectlError(
        2,
        "The verified SHA256 fingerprint (SHA256:…) is required",
      );
    await stepUp(input.password);
    const machine = await this.inventory.machine(host);
    if (!machine || !(await this.inventory.hosts()).includes(host))
      throw new HomectlError(3, "Host is not in the broker inventory");
    if (machine.transport !== "ssh" || !machine.address)
      throw new HomectlError(
        3,
        "Only SSH hosts with an address have host keys",
      );
    const scanned = await this.scan(machine);
    const stored = await readFile(this.knownHosts, "utf8").catch(() => "");
    const pinned = Object.values(
      collectHostKeys(stored, { host: { ...machine, ssh_alias: undefined } }),
    );
    const revoked = revokedBlobs(stored);
    const keys = scanned.map((key) => ({
      type: key.type,
      fingerprint: key.fingerprint,
      pinned: pinned.some((line) => line.endsWith(` ${key.type} ${key.blob}`)),
      revoked: revoked.has(key.blob),
    }));
    if (!pin)
      return {
        host,
        address: hostAddress(machine),
        trusted: false,
        notice:
          "Unverified scan. Compare a fingerprint with the host's console or provider before pinning it.",
        keys,
      };
    const chosen = scanned.find((key) => key.fingerprint === expected);
    if (!chosen)
      throw new HomectlError(
        3,
        "No key with that fingerprint was presented; nothing was pinned",
      );
    if (revoked.has(chosen.blob))
      throw new HomectlError(3, "That key is revoked; nothing was pinned");
    const line = `${hostAddress(machine)} ${chosen.type} ${chosen.blob}`;
    const same = pinned.find((entry) => entry === line);
    if (!same && pinned.length > 0)
      throw new HomectlError(
        3,
        "A different key is already pinned for this address. Remove it deliberately before pinning another.",
      );
    if (!same) await this.append(line);
    await this.events?.emit("device.updated", host, [], {
      action: "pin-host-key",
      status: same ? "unchanged" : "pinned",
      fingerprint: chosen.fingerprint,
    });
    return {
      host,
      address: hostAddress(machine),
      pinned: chosen.fingerprint,
      changed: !same,
    };
  }

  private async scan(machine: Machine): Promise<ScannedKey[]> {
    return scanHostKeys(this.runner, machine.address ?? "", machine.port ?? 22);
  }

  private async append(line: string) {
    await appendKnownHost(this.knownHosts, line);
  }
}

// What an address presents right now. A scan is never trusted by itself: the
// caller shows it as unverified, or pins only a fingerprint the owner typed.
export async function scanHostKeys(
  runner: Runner,
  address: string,
  port = 22,
): Promise<ScannedKey[]> {
  const result = await runner({
    argv: [
      executable("ssh-keyscan"),
      "-T",
      "5",
      "-p",
      String(port),
      "--",
      address,
    ],
    timeoutMs: 15_000,
  });
  const keys = parseKeyscan(result.stdout);
  if (keys.length === 0)
    throw new HomectlError(
      5,
      "The host presented no SSH keys. Check the inventory address, port and network.",
    );
  return keys;
}

// Rewrites known_hosts under its lock with an atomic replace, so a crash never
// truncates existing pins. `change` maps the current text to the new text.
// Returns the text that was replaced, so a caller can roll a change back.
export async function replaceKnownHosts(
  path: string,
  change: (current: string) => string,
): Promise<string> {
  return withFileLock(`${path}.lock`, "Known hosts", async () => {
    const current = await readFile(path, "utf8").catch(() => "");
    const next = change(current);
    if (next === current) return current;
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, next, { mode: 0o600, flag: "wx" });
    await atomicReplace(temp, path);
    return current;
  });
}

export async function appendKnownHost(path: string, line: string) {
  return replaceKnownHosts(
    path,
    (current) =>
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`,
  );
}

export async function readKnownHosts(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}
