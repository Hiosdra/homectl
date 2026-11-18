import type { PeerState, Version } from "./store";
import { hash } from "./sync";

type ApplyContext = {
  state: Pick<PeerState, "records" | "observed">;
  vault: { unlocked: boolean };
  save: () => Promise<void>;
  savedCommands: {
    replaceFromRecordsWith(
      records: Record<string, Version>,
      expectedSavedCommands:
        | Record<string, { value: unknown | null }>
        | undefined,
      apply: (savedCommandsAvailable: boolean) => Promise<void>,
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
    await context.savedCommands.replaceFromRecordsWith(
      records,
      expectedSavedCommands,
      async (savedCommandsAvailable) => {
        await applyFiles();
        const nextRecords = savedCommandsAvailable
          ? records
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
        context.state.records = nextRecords;
        context.state.observed = { ...previousObserved };
        for (const [key, version] of Object.entries(nextRecords)) {
          if (!savedCommandsAvailable && key.startsWith("saved-command:"))
            continue;
          if (!key.startsWith("credential:") || context.vault.unlocked)
            context.state.observed[key] = hash(version.value);
        }
        await context.save();
      },
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
