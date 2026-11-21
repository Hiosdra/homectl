// Steps that keep what 0.2 stored in place: the inventory (secret-free
// accounts, tiers and session settings), host trust in known_hosts including
// @revoked lines, the KeePassXC database (never opened here), saved commands
// and the audit history. They write nothing; the engine's untouched-file check
// proves they stayed byte-identical.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadInventory } from "../inventory";
import { HomectlError } from "../types";
import type { MigrationContext, MigrationStep } from "./types";

const IN_PLACE = [
  "inventory.yaml (accounts, tiers, session settings)",
  "known_hosts (pinned keys and @revoked lines)",
  "homelab.kdbx (not opened by the migration)",
  "public-keys/",
  "peers.json",
  "saved-commands.json and setup-preferences.json",
  "control-plane/audit.jsonl and audit.anchor (history, read-only evidence)",
  "history/commands.jsonl (ordinary-command history)",
];

async function knownHostsText(context: MigrationContext) {
  try {
    return await readFile(join(context.workspace, "known_hosts"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Owner access and the vault: in 0.3 the vault's master password is the owner
// credential. Without a vault, the owner sets a password with `owner init`.
export const verifyInventoryAndVault: MigrationStep = {
  id: "v2-verify-inventory-and-trust",
  from: 2,
  to: 3,
  description:
    "Check that the inventory is valid for 0.3 and that host trust and owner access are in place; change nothing",
  touches: () => [],
  async run(context) {
    const inventory = await loadInventory(context.inventoryPath);
    const database =
      inventory.session?.database ?? join(context.workspace, "homelab.kdbx");
    // Existence only: the database is never opened or decrypted here.
    const vault = await stat(database).then(
      (info) => info.isFile(),
      () => false,
    );
    context.note(
      vault
        ? "Owner access: the vault master password is the owner password in 0.3; the vault is unchanged"
        : "Owner access: no vault database was found. Set an owner password with `home-ctl owner init` before using the panel",
    );
    const hosts = await knownHostsText(context);
    if (hosts !== undefined) {
      const revoked = hosts
        .split("\n")
        .filter((line) => line.trim().startsWith("@revoked")).length;
      context.note(
        `Host trust: known_hosts kept unchanged; ${revoked} @revoked line(s) stay revoked`,
      );
    }
  },
  async verify(context) {
    try {
      await loadInventory(context.inventoryPath);
    } catch (error) {
      throw new HomectlError(
        5,
        `The inventory is not valid for homectl 0.3: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    await knownHostsText(context);
  },
};

// Lists what stayed in place and states the access changes the owner must
// know about. Writes nothing.
export const reportPreservedInPlace: MigrationStep = {
  id: "v2-report-preserved-and-agent-config",
  from: 2,
  to: 3,
  description:
    "List what stayed in place, the access narrowed from 0.2, and the agent configuration the owner must refresh",
  touches: () => [],
  async run(context) {
    context.note(`Unchanged in place: ${IN_PLACE.join("; ")}`);
    context.note(
      "Access narrowed from 0.2: 0.3 allows only read-only inspection without a prompt. 0.2 ran non-destructive changes without per-command approval on user, sudo-approved and full hosts, and sudo_allow commands on sudo-approved hosts; 0.3 asks the owner for these. Client grants are unchanged except the retired approve:decide scope",
    );
    context.note(
      "Agent configuration was not changed. A 0.2 MCP entry (HTTP to the retired control MCP, with a bearer token) cannot be repaired automatically: run `home-ctl agent connect` for each agent and review the diff, or remove the old entry by hand",
    );
    context.note(
      "Run `home-ctl setup` to refresh the bundled agent skills to 0.3",
    );
  },
  async verify() {},
};
