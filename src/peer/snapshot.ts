import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadInventory } from "../inventory";
import {
  isSavedCommandFileCorrupt,
  type SavedCommandStore,
} from "../saved-commands";
import { collectHostKeys } from "./hostkeys";
import {
  type PeerState,
  savedCommandPeerStateUnreadable,
  type Version,
} from "./store";
import {
  capture,
  filterSnapshotRecords,
  PEER_FEATURES,
  type PeerRecordIssue,
} from "./sync";
import type { Vault } from "./vault";

type SnapshotContext = {
  inventoryPath: string;
  state: PeerState;
  savedCommands: SavedCommandStore;
  vault: Pick<Vault, "unlocked" | "snapshot">;
  save: () => Promise<void>;
};

export async function snapshotWithIssues(
  context: SnapshotContext,
  forWire = true,
  features: readonly string[] = PEER_FEATURES,
): Promise<{ records: Record<string, Version>; issues: PeerRecordIssue[] }> {
  const inventory = await loadInventory(context.inventoryPath);
  const values: Record<string, unknown> = {};
  for (const [name, machine] of Object.entries(inventory.machines))
    if (machine.transport === "ssh")
      values[`machine:${name}`] = {
        name,
        ...machine,
        auth: machine.auth
          ? { type: machine.auth.type, entry: machine.auth.entry }
          : undefined,
      };
  for (const [name, provider] of Object.entries(inventory.providers ?? {}))
    values[`provider:${name}`] = { name, ...provider };

  let savedCommands: Awaited<ReturnType<SavedCommandStore["listWithIssues"]>> =
    { commands: [], invalid: [] };
  const issues: PeerRecordIssue[] = [];
  let savedCommandsAvailable = true;
  try {
    savedCommands = await context.savedCommands.listWithIssues();
  } catch (error) {
    savedCommandsAvailable = false;
    issues.push({
      id: "saved-commands",
      reason: isSavedCommandFileCorrupt(error)
        ? "Saved command file is corrupt; saved-command sync is disabled. Preserve it and investigate."
        : "Saved command file could not be read; saved-command sync is disabled for this snapshot. Preserve it and investigate.",
    });
  }
  // Without the saved-command peer state the clocks are unknown: recapturing
  // local commands with fresh clocks would let older peer copies win silently.
  if (
    savedCommandsAvailable &&
    savedCommandPeerStateUnreadable(context.inventoryPath)
  ) {
    savedCommandsAvailable = false;
    savedCommands = { commands: [], invalid: [] };
    issues.push({
      id: "saved-commands",
      reason:
        "Saved-command sync state (peers-saved-commands.json) could not be read; saved-command sync is disabled. Preserve it and investigate.",
    });
  }
  issues.push(
    ...savedCommands.invalid.map((item) => ({
      id: `saved-command:${item.id}`,
      reason: item.reason,
    })),
  );
  const invalidSavedCommandIds = savedCommandsAvailable
    ? new Set(savedCommands.invalid.map((item) => `saved-command:${item.id}`))
    : new Set(
        [
          ...Object.keys(context.state.records),
          ...Object.keys(context.state.observed),
        ].filter((id) => id.startsWith("saved-command:")),
      );
  for (const command of savedCommands.commands)
    values[`saved-command:${command.id}`] = command;

  const prefixes = ["machine:", "provider:"];
  if (savedCommandsAvailable) prefixes.push("saved-command:");
  if (context.vault.unlocked) {
    prefixes.push("credential:");
    for (const [name, value] of Object.entries(context.vault.snapshot()))
      values[`credential:${name}`] = value;
  }
  const knownHosts = join(dirname(context.inventoryPath), "known_hosts");
  for (const source of [join(homedir(), ".ssh", "known_hosts"), knownHosts]) {
    try {
      Object.assign(
        values,
        collectHostKeys(await readFile(source, "utf8"), inventory.machines),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  prefixes.push("hostkey:");
  capture(context.state, values, prefixes, invalidSavedCommandIds);
  await context.save();
  return {
    records: filterSnapshotRecords(context.state.records, {
      forWire,
      vaultUnlocked: context.vault.unlocked,
      features,
      invalidSavedCommandIds,
    }),
    issues,
  };
}
