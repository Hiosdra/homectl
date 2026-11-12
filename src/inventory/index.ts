import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Ajv from "ajv";
import { parse, stringify } from "yaml";
import schema from "../../schema/inventory.schema.json";
import { atomicReplace, privateDirectory, protect } from "../platform";
import { idleSeconds, ttlSeconds } from "../session/config";
import { HomectlError, type Inventory, type Machine } from "../types";

const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
export function parseInventory(text: string): Inventory {
  let data: unknown;
  try {
    data = parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    throw new HomectlError(
      2,
      "Invalid YAML (duplicate keys and aliases are forbidden)",
    );
  }
  if (!validate(data))
    throw new HomectlError(
      2,
      "Inventory schema validation failed",
      validate.errors?.map((e) => ({
        path: e.instancePath,
        keyword: e.keyword,
      })),
    ); // Do not echo offending values.
  const inventory = data as unknown as Inventory;
  if (inventory.session) ttlSeconds(inventory.session.ttl);
  if (inventory.session?.idle !== undefined)
    idleSeconds(inventory.session.idle);
  const aliases = new Set<string>();
  for (const m of Object.values(inventory.machines)) {
    if (m.auth?.type === "keepassxc" && !inventory.session)
      throw new HomectlError(
        2,
        "KeePassXC hosts require an inventory session configuration",
      );
    if (
      m.transport === "local" &&
      (m.auth || m.ssh_alias || m.address || m.user)
    )
      throw new HomectlError(2, "Local machines cannot specify SSH fields");
    if (m.user === "root" && m.access !== "full")
      throw new HomectlError(2, "Root SSH accounts require full access");
    if (
      m.enforcement === "sudoers" &&
      !["full", "sudo-approved"].includes(m.access)
    )
      throw new HomectlError(
        2,
        "sudoers enforcement only applies to privileged tiers",
      );
    if (m.access === "sudo-approved" && !m.sudo_allow?.length)
      throw new HomectlError(
        2,
        "sudo-approved requires exact sudo_allow argv entries",
      );
    if (
      m.sudo_allow?.some(
        (a) =>
          !a[0]?.startsWith("/") ||
          a.some(
            (v) => v.includes("\r") || v.includes("\n") || v.includes("\0"),
          ),
      )
    )
      throw new HomectlError(
        2,
        "sudo_allow requires absolute executable paths and no control characters",
      );
    if (m.ssh_alias) {
      if (aliases.has(m.ssh_alias))
        throw new HomectlError(2, "Duplicate SSH alias");
      aliases.add(m.ssh_alias);
    }
  }
  for (const p of Object.values(inventory.providers ?? {})) {
    const host = inventory.machines[p.host];
    if (
      !host ||
      host.transport !== "ssh" ||
      host.access !== "full" ||
      host.auth?.type !== "keepassxc"
    )
      throw new HomectlError(
        2,
        "Proxmox provider must reference an existing SSH host with full access and a managed key",
      );
    // Facts for the guest catalogue: a sane VMID range, and allowlists that are unique.
    const range = p.vmid_range;
    if (
      range &&
      (range[0] > range[1] || range[0] < 100 || range[1] > 999999999)
    )
      throw new HomectlError(
        2,
        "Proxmox vmid_range must be an ascending pair between 100 and 999999999",
      );
    if (
      p.protected_vmids &&
      (new Set(p.protected_vmids).size !== p.protected_vmids.length ||
        p.protected_vmids.some(
          (vmid) => !Number.isInteger(vmid) || vmid < 100 || vmid > 999999999,
        ))
    )
      throw new HomectlError(
        2,
        "Proxmox protected_vmids must be unique integers between 100 and 999999999",
      );
    if (p.storages && new Set(p.storages).size !== p.storages.length)
      throw new HomectlError(2, "Proxmox storages must be unique");
    if (p.templates && new Set(p.templates).size !== p.templates.length)
      throw new HomectlError(2, "Proxmox templates must be unique");
  }
  return inventory;
}
export async function loadInventory(path: string): Promise<Inventory> {
  try {
    return parseInventory(await readFile(path, "utf8"));
  } catch (e) {
    if (e instanceof HomectlError) throw e;
    throw new HomectlError(2, "Cannot read inventory; run home-ctl setup");
  }
}
export async function saveInventory(path: string, inventory: Inventory) {
  const text = stringify(inventory);
  parseInventory(text);
  await privateDirectory(dirname(path));
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  await protect(temp);
  await atomicReplace(temp, path);
}
export function resolveHost(inventory: Inventory, name: string): Machine {
  const m = inventory.machines[name];
  if (!m) throw new HomectlError(2, "Unknown inventory host");
  return m;
}
