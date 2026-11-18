import type {
  SavedCommand,
  SavedCommandRecordIssue,
} from "./saved-command-types";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseSavedCommandsFromRecordsWithIssues(
  records: Record<string, { value: unknown | null }>,
  validateStored: (value: unknown, expectedId?: string) => SavedCommand,
): { commands: SavedCommand[]; issues: SavedCommandRecordIssue[] } {
  const commands: SavedCommand[] = [];
  const issues: SavedCommandRecordIssue[] = [];
  for (const [key, version] of Object.entries(records)) {
    if (!key.startsWith("saved-command:")) continue;
    if (!record(version) || !("value" in version)) {
      issues.push({ id: key, reason: "Invalid saved-command record" });
      continue;
    }
    if (version.value === null) continue;
    const id = key.slice("saved-command:".length);
    try {
      const command = validateStored(
        id.startsWith("copy-") && record(version.value)
          ? { ...version.value, id }
          : version.value,
        id,
      );
      commands.push(command);
    } catch (error) {
      issues.push({
        id: key,
        reason:
          error instanceof Error ? error.message : "Invalid saved command",
      });
    }
  }
  const usedNames = new Set(
    commands
      .filter((command) => !command.id.startsWith("copy-"))
      .map((command) => command.name.toLocaleLowerCase()),
  );
  const lexical = (a: SavedCommand, b: SavedCommand) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const originals = commands
    .filter((command) => !command.id.startsWith("copy-"))
    .sort(lexical);
  const retainedNames = new Set<string>();
  for (const command of originals) {
    const key = command.name.toLocaleLowerCase();
    if (!retainedNames.has(key)) {
      retainedNames.add(key);
      continue;
    }
    const baseName = command.name;
    let suffixNumber = 1;
    let candidate: string;
    do {
      const suffix = ` (device-${command.id.slice(0, 8)}${suffixNumber === 1 ? "" : `-${suffixNumber}`})`;
      candidate = `${baseName.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
      suffixNumber++;
    } while (usedNames.has(candidate.toLocaleLowerCase()));
    command.name = candidate;
    usedNames.add(candidate.toLocaleLowerCase());
  }
  for (const command of commands
    .filter((item) => item.id.startsWith("copy-"))
    .sort(lexical)) {
    const baseName = command.name.replace(/ \(copy(?: \d+)?\)$/, "");
    let suffixNumber = 1;
    let candidate: string;
    do {
      const suffix = suffixNumber === 1 ? " (copy)" : ` (copy ${suffixNumber})`;
      candidate = `${baseName.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
      suffixNumber++;
    } while (usedNames.has(candidate.toLocaleLowerCase()));
    command.name = candidate;
    usedNames.add(candidate.toLocaleLowerCase());
  }
  return {
    commands: commands.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    issues,
  };
}
