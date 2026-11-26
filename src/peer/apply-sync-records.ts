import {
  type PeerState,
  savedCommandPeerStateUnreadable,
  type Version,
} from "./store";
import { hash } from "./sync";

type ApplyContext = {
  inventoryPath?: string;
  state: Pick<PeerState, "records" | "observed">;
  vault: { unlocked: boolean };
  save: () => Promise<void>;
  savedCommands: {
    replaceFromRecordsWith(
      records: Record<string, Version>,
      expectedSavedCommands:
        Record<string, { value: unknown | null }> | undefined,
      apply: (
        savedCommandsAvailable: boolean,
        preservedInvalidIds: string[],
      ) => Promise<void>,
    ): Promise<boolean>;
  };
};

export async function savePeerSyncRecords(
  context: ApplyContext,
  records: Record<string, Version>,
  expectedSavedCommands?: Record<string, { value: unknown | null }>,
  applyFiles: () => Promise<void> = async () => {},
): Promise<void> {
  const previousRecords = context.state.records;
  const previousObserved = context.state.observed;
  try {
    const finish = async (
      savedCommandsAvailable: boolean,
      preservedInvalidIds: string[],
    ) => {
      await applyFiles();
      const nextRecords: typeof records = savedCommandsAvailable
        ? { ...records }
        : {
            ...Object.fromEntries(
              Object.entries(records).filter(
                ([key]) => !key.startsWith("saved-command:"),
              ),
            ),
            ...Object.fromEntries(
              Object.entries(previousRecords).filter(([key]) =>
                key.startsWith("saved-command:"),
              ),
            ),
          };
      if (savedCommandsAvailable)
        for (const id of preservedInvalidIds) {
          if (previousRecords[id]) nextRecords[id] = previousRecords[id];
          else delete nextRecords[id];
        }
      context.state.records = nextRecords;
      context.state.observed = { ...previousObserved };
      for (const [key, version] of Object.entries(nextRecords)) {
        if (!savedCommandsAvailable && key.startsWith("saved-command:"))
          continue;
        if (preservedInvalidIds.includes(key)) continue;
        if (!key.startsWith("credential:") || context.vault.unlocked)
          context.state.observed[key] = hash(version.value);
      }
      await context.save();
    };
    if (
      context.inventoryPath !== undefined &&
      savedCommandPeerStateUnreadable(context.inventoryPath)
    )
      // Saved-command sync is disabled: leave saved-commands.json alone and
      // keep saved-command records pending.
      await finish(false, []);
    else
      await context.savedCommands.replaceFromRecordsWith(
        records,
        expectedSavedCommands,
        finish,
      );
  } catch (error) {
    context.state.records = previousRecords;
    context.state.observed = previousObserved;
    try {
      await context.save();
    } catch {
      console.warn(
        "Could not restore peer sync state after saved-command apply failed.",
      );
    }
    throw error;
  }
}
