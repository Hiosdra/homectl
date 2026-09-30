import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Ajv from "ajv";
import { parse, stringify } from "yaml";
import schema from "../../schema/inventory.schema.json";
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
  const aliases = new Set<string>();
  for (const m of Object.values(inventory.machines)) {
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
  for (const p of Object.values(inventory.providers ?? {}))
    if (p.auth.type !== "bitwarden-agent-access")
      throw new HomectlError(
        2,
        "Proxmox requires bitwarden-agent-access token injection",
      );
  return inventory;
}
export async function loadInventory(path: string): Promise<Inventory> {
  try {
    return parseInventory(await readFile(path, "utf8"));
  } catch (e) {
    if (e instanceof HomectlError) throw e;
    throw new HomectlError(2, "Cannot read inventory; run homectl setup");
  }
}
export async function saveInventory(path: string, inventory: Inventory) {
  const text = stringify(inventory);
  parseInventory(text);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}
export function resolveHost(inventory: Inventory, name: string): Machine {
  const m = inventory.machines[name];
  if (!m) throw new HomectlError(2, "Unknown inventory host");
  return m;
}
