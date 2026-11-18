import type { PeerState, Version } from "./store";
import { hash } from "./sync";

type ApplyContext = {
  state: Pick<PeerState, "records" | "observed">;
  vault: { unlocked: boolean };
  save: () => Promise<void>;
  savedCommands: {
    replaceFromRecords(
      records: Record<string, Version>,
      expectedSavedCommands?: Record<string, { value: unknown | null }>,
    ): Promise<unknown>;
  };
};

export async function savePeerSyncRecords(
  context: ApplyContext,
  records: Record<string, Version>,
  expectedSavedCommands?: Record<string, { value: unknown | null }>,
): Promise<void> {
  const previousRecords = context.state.records;
  const previousObserved = context.state.observed;
  context.state.records = records;
  context.state.observed = { ...previousObserved };
  for (const [key, version] of Object.entries(records))
    if (!key.startsWith("credential:") || context.vault.unlocked)
      context.state.observed[key] = hash(version.value);
  try {
    await context.save();
    await context.savedCommands.replaceFromRecords(
      records,
      expectedSavedCommands,
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
