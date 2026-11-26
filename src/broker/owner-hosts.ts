// Owner-panel machines (0.3 guided setup, part 2). The routes reuse the CLI
// internals rather than forking them: `enroll` (inventory, SSH config and the
// uname probe), the host-key scan and pin behind `owner scan-host-keys` and
// `owner pin-host-key`, and the public-key read behind `key inspect`.
// A scan is never trusted by itself. Enrolment pins only the fingerprint the
// owner typed, and rolls the pin back if enrolment does not finish.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClientView } from "../control/types";
import { ScanRecords } from "./scan-records";
import { enroll, probeMachine } from "../enroll";
import { collectHostKeys, hostAddress } from "../peer/hostkeys";
import { loadInventory, parseInventory, saveInventory } from "../inventory";
import { writeSSHConfig } from "../operations";
import { run } from "../process";
import { readMachineKey } from "./machine-key-status";
import { keyReference } from "../session/keys";
import {
  appendKnownHost,
  keyFingerprint,
  readKnownHosts,
  replaceKnownHosts,
  revokedBlobs,
  scanHostKeys,
} from "./host-keys";
import {
  checkAccess,
  checkAddress,
  checkFingerprint,
  checkLogin,
  checkName,
  checkPort,
  checkSudoAllow,
  ProbeStore,
} from "./owner-hosts-input";
import type { RouteExtension } from "./server";
import type { EventsPort } from "./types";
import {
  type Inventory,
  HomectlError,
  type Machine,
  type Runner,
} from "../types";

export interface OwnerHostsOptions {
  inventoryPath: string;
  configPath: string;
  // The broker's state directory (the probe record lives there).
  state: string;
  clients: {
    list(): Promise<ClientView[]>;
    dropHost(host: string): Promise<number>;
  };
  // Tests and the browser smoke inject a stub; the default is the real ssh.
  runner?: Runner;
  events?: EventsPort;
  // Runs after the set of machines changes, so the broker's host list follows.
  onInventoryChanged?: () => Promise<void>;
  // Creates a managed key in the broker vault, with a public file for the owner.
  createKey?: (name: string) => Promise<void>;
  // Loads a managed key into the broker's agent before a probe (vault only).
  loadKey?: (entry: string) => Promise<void>;
  now?: () => number;
}

const NOT_VERIFIED =
  "Not verified yet. This is what the network presented, and it is not proof. Compare it with the fingerprint on the machine's own console before you confirm.";

function sshShape(address: string, port: number): Machine {
  return {
    description: "",
    transport: "ssh",
    access: "observe",
    address,
    ...(port === 22 ? {} : { port }),
  };
}

// The fingerprint of the pinned key for a machine: ed25519 when both are pinned.
function pinnedFingerprint(known: string, machine: Machine): string | null {
  const parsed = Object.values(
    collectHostKeys(known, { host: { ...machine, ssh_alias: undefined } }),
  )
    .map((line) => line.split(" "))
    .filter((fields) => fields.length >= 3);
  const chosen =
    parsed.find((fields) => fields[1] === "ssh-ed25519") ?? parsed[0];
  return chosen?.[2] ? keyFingerprint(chosen[2]) : null;
}

// Removes the plain pins for one address (hashed entries are not ours to match).
function withoutPins(
  text: string,
  address: string,
): { text: string; removed: number } {
  let removed = 0;
  const lines = text.split("\n").filter((line) => {
    const fields = line.trim().split(/\s+/);
    const drop = fields[0] === address && fields.length >= 3;
    if (drop) removed += 1;
    return !drop;
  });
  return { text: lines.join("\n"), removed };
}

export class OwnerHostRoutes implements RouteExtension {
  private readonly runner: Runner;
  private readonly knownHosts: string;
  private readonly probes: ProbeStore;
  private readonly scans: ScanRecords;
  private readonly now: () => number;

  constructor(private readonly options: OwnerHostsOptions) {
    this.runner = options.runner ?? run;
    this.knownHosts = join(dirname(options.inventoryPath), "known_hosts");
    this.probes = new ProbeStore(options.state);
    this.scans = new ScanRecords(options.state);
    this.now = options.now ?? Date.now;
  }

  // GET /v1/owner/hosts is the only read; everything else is a POST. Each write
  // asks for the owner password (step-up) before it changes anything.
  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    switch (path) {
      case "/v1/owner/hosts":
        return this.list();
      case "/v1/owner/hosts/key-status":
        return readMachineKey(
          this.options.inventoryPath,
          checkName(input.name),
        );
      case "/v1/owner/hosts/create-key": {
        await stepUp(input.password);
        const name = checkName(input.name);
        if (!this.options.createKey)
          throw new HomectlError(
            3,
            "Set up the broker vault before creating a machine key",
          );
        if (
          Object.hasOwn(
            (await loadInventory(this.options.inventoryPath)).machines,
            name,
          )
        )
          throw new HomectlError(
            3,
            "This machine is already enrolled. Use a new name for a new machine key.",
          );
        await this.options.createKey(name);
        return readMachineKey(this.options.inventoryPath, name);
      }
      case "/v1/owner/hosts/scan":
        await stepUp(input.password);
        return this.scan(input);
      case "/v1/owner/hosts/enroll":
        await stepUp(input.password);
        return this.enroll(input);
      case "/v1/owner/hosts/probe":
        await stepUp(input.password);
        return this.probe(input);
      case "/v1/owner/hosts/access":
        // A change of access level is a trust change: always the password.
        await stepUp(input.password);
        return this.access(input);
      case "/v1/owner/hosts/remove":
        await stepUp(input.password);
        return this.remove(input);
      default:
        return undefined;
    }
  }

  // Machines and what the owner needs to see about them. No key material and
  // no key paths: the public facts and the plain probe record only.
  // Also read by the setup routes (the agent's machine view is built from it).
  async list() {
    const inventory = await loadInventory(this.options.inventoryPath);
    const [clients, probes, known] = await Promise.all([
      this.options.clients.list(),
      this.probes.load(),
      readKnownHosts(this.knownHosts),
    ]);
    const machines = Object.entries(inventory.machines)
      .filter(([, machine]) => machine.transport === "ssh")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, machine]) => {
        const probe = probes[name];
        return {
          name,
          description: machine.description,
          address: machine.address ?? "",
          port: machine.port ?? 22,
          user: machine.user ?? "",
          access: machine.access,
          sudoAllow: (machine.sudo_allow ?? []).map((argv) => argv.join(" ")),
          enforcement: machine.enforcement ?? "advisory",
          caution: machine.caution ?? [],
          pinned: pinnedFingerprint(known, machine),
          probe: probe ?? null,
          assistants: clients
            .filter((client) => !client.revoked && client.hosts.includes(name))
            .map((client) => ({
              id: client.id,
              name: client.name || client.id,
            })),
        };
      });
    return { machines };
  }

  // Counts for the setup checklist: enrolled machines, and those pinned with a
  // probe that answered OK. Counts only; the list itself stays behind the session.
  async readiness(): Promise<{ enrolled: number; ready: number }> {
    const { machines } = await this.list();
    return {
      enrolled: machines.length,
      ready: machines.filter(
        (machine) => machine.pinned !== null && machine.probe?.ok === true,
      ).length,
    };
  }

  // What an address presents now. Shown as unverified; pins nothing. The result is
  // recorded: an enrolment may start only from a recent scan (scan-records.ts).
  private async scan(input: Record<string, unknown>) {
    const address = checkAddress(input.address);
    const port = checkPort(input.port);
    const keys = await scanHostKeys(this.runner, address, port);
    const fingerprints = keys.map(({ type, fingerprint }) => ({
      type,
      fingerprint,
    }));
    await this.scans.set({ address, port, at: this.now(), keys: fingerprints });
    const stored = await readKnownHosts(this.knownHosts);
    const shape = sshShape(address, port);
    const pinned = Object.values(collectHostKeys(stored, { host: shape }));
    const revoked = revokedBlobs(stored);
    return {
      address: hostAddress(shape),
      trusted: false,
      notice: NOT_VERIFIED,
      keys: keys.map((key) => ({
        type: key.type,
        fingerprint: key.fingerprint,
        pinned: pinned.some((line) =>
          line.endsWith(` ${key.type} ${key.blob}`),
        ),
        revoked: revoked.has(key.blob),
      })),
    };
  }

  // Enrolment: the typed fingerprint must match a key the address presents now,
  // then the pin, the inventory entry and the probe. A failure after the pin
  // rolls the pin back, so nothing stays trusted for a machine that is not listed.
  private async enroll(input: Record<string, unknown>) {
    const name = checkName(input.name);
    const address = checkAddress(input.address);
    const port = checkPort(input.port);
    const login = checkLogin(input.user);
    const access = checkAccess(input.access);
    const fingerprint = checkFingerprint(input.fingerprint);
    const sudoAllow = checkSudoAllow(input.sudo_allow, access);
    if (login === "root" && access !== "full")
      throw new HomectlError(
        2,
        "The root account always has full access. Choose Full admin for it.",
      );
    if (access === "sudo-approved" && !sudoAllow)
      throw new HomectlError(
        2,
        "Admin with your approval needs at least one allowed command.",
      );
    const inventory = await loadInventory(this.options.inventoryPath);
    if (inventory.machines[name])
      throw new HomectlError(
        3,
        `A machine named ${name} is already in your list.`,
      );
    const key = await readMachineKey(this.options.inventoryPath, name);
    if (!key.present)
      throw new HomectlError(
        2,
        `No key named ${name} yet. In your private terminal run: home-ctl key create ${name}`,
      );

    const scanned = await scanHostKeys(this.runner, address, port);
    const chosen = scanned.find((item) => item.fingerprint === fingerprint);
    if (!chosen)
      throw new HomectlError(
        3,
        "No key with that fingerprint was presented; nothing was pinned",
      );
    const stored = await readKnownHosts(this.knownHosts);
    if (revokedBlobs(stored).has(chosen.blob))
      throw new HomectlError(3, "That key is revoked; nothing was pinned");
    const shape = sshShape(address, port);
    const pinned = Object.values(collectHostKeys(stored, { host: shape }));
    const line = `${hostAddress(shape)} ${chosen.type} ${chosen.blob}`;
    const same = pinned.includes(line);
    if (!same && pinned.length > 0)
      throw new HomectlError(
        3,
        "A different key is already pinned for this address. Remove it deliberately before pinning another.",
      );

    const auth = keyReference(name, this.options.inventoryPath);
    const machine: Machine = {
      description: "Added in the owner panel",
      transport: "ssh",
      access,
      // The SSH alias is the machine's name: the generated ssh config uses it.
      ssh_alias: name,
      address,
      user: login,
      auth,
      ...(port === 22 ? {} : { port }),
      ...(sudoAllow ? { sudo_allow: sudoAllow } : {}),
    };
    const previous = same
      ? undefined
      : await appendKnownHost(this.knownHosts, line);
    try {
      await this.options.loadKey?.(auth.entry).catch(() => undefined);
      const { os } = await enroll(
        name,
        machine,
        this.options.inventoryPath,
        this.options.configPath,
        { runner: this.runner },
      );
      const at = this.now();
      await this.probes.set(name, { checkedAt: at, ok: true, os, okAt: at });
      await this.options.onInventoryChanged?.();
      await this.options.events?.emit("device.updated", name, [], {
        action: "enroll-host",
        status: "enrolled",
        fingerprint,
      });
      return { name, os, pinned: fingerprint, access };
    } catch (error) {
      if (previous !== undefined)
        await replaceKnownHosts(this.knownHosts, () => previous);
      throw error;
    }
  }

  // A fresh check: one read-only `uname -s`, the same probe enroll runs. The
  // result is recorded either way; a failure comes back as a plain reason.
  private async probe(input: Record<string, unknown>) {
    const name = checkName(input.name);
    const { machine } = await this.sshMachine(name);
    if (machine.auth)
      await this.options.loadKey?.(machine.auth.entry).catch(() => undefined);
    const at = this.now();
    try {
      const os = await probeMachine(
        machine,
        this.options.configPath,
        this.runner,
      );
      await this.probes.set(name, { checkedAt: at, ok: true, os, okAt: at });
      return { name, ok: true, os, checkedAt: at };
    } catch (error) {
      if (!(error instanceof HomectlError) || error.code !== 5) throw error;
      const last = (await this.probes.load())[name];
      await this.probes.set(name, {
        checkedAt: at,
        ok: false,
        reason: error.message,
        ...(last?.okAt === undefined ? {} : { os: last.os, okAt: last.okAt }),
      });
      return { name, ok: false, reason: error.message, checkedAt: at };
    }
  }

  // Changes the access level. Root is always full; sudo-approved needs its
  // commands. Lower levels drop the settings they do not use.
  private async access(input: Record<string, unknown>) {
    const name = checkName(input.name);
    const access = checkAccess(input.access);
    const sudoAllow = checkSudoAllow(input.sudo_allow, access);
    await this.editInventory((inventory) => {
      const machine = this.inventoryMachine(inventory, name);
      if (machine.user === "root" && access !== "full")
        throw new HomectlError(
          2,
          "The root account always has full access. It cannot be lowered.",
        );
      if (
        access === "sudo-approved" &&
        !sudoAllow &&
        !machine.sudo_allow?.length
      )
        throw new HomectlError(
          2,
          "Admin with your approval needs at least one allowed command.",
        );
      const next: Machine = { ...machine, access };
      if (access === "observe" || access === "user") delete next.enforcement;
      if (access !== "sudo-approved") delete next.sudo_allow;
      else if (sudoAllow) next.sudo_allow = sudoAllow;
      inventory.machines[name] = next;
    });
    await this.options.events?.emit("device.updated", name, [], {
      action: "set-access",
      status: "changed",
      access,
    });
    return { name, access };
  }

  // Removes the machine from homectl: its inventory entry, the assistants'
  // grants to it, its pinned host key and its probe record. It does not delete
  // the vault key, the public key on the machine, or anything on the machine.
  private async remove(input: Record<string, unknown>) {
    const name = checkName(input.name);
    const found: { machine?: Machine } = {};
    await this.editInventory((inventory) => {
      found.machine = this.inventoryMachine(inventory, name);
      const providers = Object.entries(inventory.providers ?? {})
        .filter(([, provider]) => provider.host === name)
        .map(([id]) => id);
      if (providers.length > 0)
        throw new HomectlError(
          2,
          `The Proxmox provider ${providers.join(", ")} uses this machine. Remove or change that provider first.`,
        );
      delete inventory.machines[name];
    });
    const machine = found.machine;
    const assistants = await this.options.clients.dropHost(name);
    const pins = { removed: 0 };
    if (machine?.address) {
      const address = hostAddress(machine);
      await replaceKnownHosts(this.knownHosts, (current) => {
        const result = withoutPins(current, address);
        pins.removed = result.removed;
        return result.text;
      });
    }
    await this.probes.set(name, undefined);
    const remaining = await loadInventory(this.options.inventoryPath);
    await writeSSHConfig(this.options.configPath, remaining.machines);
    await this.options.onInventoryChanged?.();
    await this.options.events?.emit("device.updated", name, [], {
      action: "remove-host",
      status: "removed",
    });
    return {
      name,
      removed: true,
      assistantsUpdated: assistants,
      pinRemoved: pins.removed > 0,
    };
  }

  private async sshMachine(
    name: string,
  ): Promise<{ machine: Machine; inventory: Inventory }> {
    const inventory = await loadInventory(this.options.inventoryPath);
    return { machine: this.inventoryMachine(inventory, name), inventory };
  }

  private inventoryMachine(inventory: Inventory, name: string): Machine {
    const machine = inventory.machines[name];
    if (machine?.transport !== "ssh")
      throw new HomectlError(2, `No machine named ${name} in your list.`);
    return machine;
  }

  // Edits the inventory. The file is read first and must be unchanged when the
  // edit is saved, so a concurrent change is refused rather than overwritten.
  private async editInventory(edit: (inventory: Inventory) => void) {
    const before = await readFile(this.options.inventoryPath, "utf8");
    const inventory = parseInventory(before);
    edit(inventory);
    if ((await readFile(this.options.inventoryPath, "utf8")) !== before)
      throw new HomectlError(
        3,
        "The machine list changed while you were working. Try again.",
      );
    await saveInventory(this.options.inventoryPath, inventory);
  }
}
