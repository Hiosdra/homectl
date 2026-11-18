import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDirectoryOnce, withFileLock } from "./control/file-lock";
import { redactArgvBroad } from "./control/redact";
import { atomicReplace, protect } from "./platform";
import { parseSavedCommandsFromRecordsWithIssues } from "./saved-command-records";
import {
  SAVED_COMMAND_VERSION,
  type SavedCommand,
  type SavedCommandIssue,
  type SavedCommandRecordIssue,
} from "./saved-command-types";
import {
  isValidSavedCommandId,
  validateFields,
  validateStored,
} from "./saved-command-validation";
import { HomectlError } from "./types";

export {
  SAVED_COMMAND_VERSION,
  type SavedCommand,
  type SavedCommandInput,
  type SavedCommandIssue,
  type SavedCommandParameter,
  type SavedCommandRecordIssue,
} from "./saved-command-types";

// A saved command stores only a template. It never stores approvals or defaults
// for parameters; every invocation expands to a fresh argv and uses exec policy.
type InvalidSavedCommandRecord = {
  value: unknown;
  reason: string;
};
type DiskState = {
  version: 1;
  commands: Record<string, SavedCommand>;
  invalid: Record<string, InvalidSavedCommandRecord>;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function stableCommandMap(commands: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(commands)
      .sort()
      .map((id) => [
        id,
        Object.hasOwn(commands, id) ? commands[id] : undefined,
      ]),
  );
}

function expectedCommandMap(
  expectedSavedCommands?: Record<string, { value: unknown | null }>,
): Record<string, SavedCommand> | undefined {
  if (!expectedSavedCommands) return undefined;
  const expected = dictionary<SavedCommand>();
  for (const [recordId, version] of Object.entries(expectedSavedCommands))
    if (recordId.startsWith("saved-command:") && version.value !== null) {
      const commandId = recordId.slice("saved-command:".length);
      expected[commandId] = validateStored(version.value, commandId);
    }
  return expected;
}

function assertExpectedCommands(
  current: DiskState,
  expected: Record<string, SavedCommand> | undefined,
): void {
  const expectedForValidLocalCommands = expected
    ? Object.fromEntries(
        Object.entries(expected).filter(
          ([id]) => !Object.hasOwn(current.invalid, id),
        ),
      )
    : undefined;
  if (
    expectedForValidLocalCommands &&
    stableCommandMap(current.commands) !==
      stableCommandMap(expectedForValidLocalCommands)
  )
    throw new HomectlError(
      3,
      "Saved commands changed since the sync preview; refresh before applying",
    );
}

export function expandSavedCommand(
  command: SavedCommand,
  host: string,
  values: Record<string, string>,
): string[] {
  if (!command.hosts.includes(host))
    throw new HomectlError(
      3,
      `Host ${host} is not allowed by this saved command`,
    );
  const declared = new Set(
    command.parameters.map((parameter) => parameter.name),
  );
  const supplied = Object.keys(values);
  const missing = [...declared].filter((name) => !Object.hasOwn(values, name));
  const unexpected = supplied.filter((name) => !declared.has(name));
  if (missing.length)
    throw new HomectlError(2, `Provide values for: ${missing.join(", ")}`);
  if (unexpected.length)
    throw new HomectlError(2, `Unknown parameter(s): ${unexpected.join(", ")}`);
  for (const [name, value] of Object.entries(values))
    if (!value || value.length > 4096 || value.includes("\0"))
      throw new HomectlError(
        2,
        `Parameter ${name} must be non-empty and under 4096 characters`,
      );
  const argv = command.argv.map((arg) =>
    arg.replace(
      /\{\{([a-z][a-z0-9_-]{0,31})\}\}/g,
      (_, name: string) => values[name] ?? "",
    ),
  );
  if (argv.some((arg) => !arg))
    throw new HomectlError(2, "Parameter expansion produced an empty argument");
  return argv;
}

export function redactSavedCommandArgv(
  command: SavedCommand,
  argv: string[],
  values: Record<string, string>,
): string[] {
  const redacted = redactArgvBroad(argv);
  for (const parameter of command.parameters) {
    if (!parameter.secret) continue;
    const secret = values[parameter.name];
    if (!secret) continue;
    for (const [index, argument] of argv.entries())
      if (redacted[index] === argument && argument.includes(secret))
        redacted[index] = argument.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function savedCommandsFromRecordsWithIssues(
  records: Record<string, { value: unknown | null }>,
): { commands: SavedCommand[]; issues: SavedCommandRecordIssue[] } {
  return parseSavedCommandsFromRecordsWithIssues(records, validateStored);
}

export function savedCommandsFromRecords(
  records: Record<string, { value: unknown | null }>,
): SavedCommand[] {
  return savedCommandsFromRecordsWithIssues(records).commands;
}

export function isSavedCommandFileCorrupt(error: unknown): boolean {
  return (
    error instanceof HomectlError &&
    error.message.startsWith("Saved command file is corrupt;")
  );
}

export function availableCommandHosts(
  command: SavedCommand,
  inventoryHosts: Iterable<string>,
) {
  const known = new Set(inventoryHosts);
  return {
    available: command.hosts.filter((host) => known.has(host)),
    unavailable: command.hosts.filter((host) => !known.has(host)),
  };
}

export class SavedCommandStore {
  private readonly lockPath: string;

  constructor(readonly path: string) {
    this.lockPath = `${path}.lock`;
  }

  static forInventory(inventoryPath: string) {
    return new SavedCommandStore(
      join(dirname(resolve(inventoryPath)), "saved-commands.json"),
    );
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectoryOnce(dirname(this.path));
    return withFileLock(this.lockPath, "Saved commands", fn);
  }

  private async read(): Promise<DiskState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          version: 1,
          commands: dictionary<SavedCommand>(),
          invalid: dictionary<InvalidSavedCommandRecord>(),
        };
      throw new HomectlError(5, "Saved commands cannot be read");
    }
    try {
      const state = JSON.parse(text) as DiskState;
      if (state.version !== 1 || !record(state.commands)) throw new Error();
      const commands = dictionary<SavedCommand>();
      const invalid = dictionary<InvalidSavedCommandRecord>();
      let invalidRecords = 0;
      for (const [id, command] of Object.entries(state.commands)) {
        try {
          commands[id] = validateStored(command, id);
        } catch (error) {
          invalidRecords++;
          invalid[id] = {
            value: command,
            reason:
              error instanceof Error ? error.message : "Invalid saved command",
          };
        }
      }
      if (invalidRecords)
        console.warn(
          `Skipped ${invalidRecords} invalid saved command record${invalidRecords === 1 ? "" : "s"}.`,
        );
      return { version: 1, commands, invalid };
    } catch {
      throw new HomectlError(
        5,
        "Saved command file is corrupt; preserve it and investigate",
      );
    }
  }

  private async write(state: DiskState): Promise<string> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const commands = dictionary<unknown>();
    for (const [id, entry] of Object.entries(state.invalid))
      if (!Object.hasOwn(state.commands, id)) commands[id] = entry.value;
    for (const [id, command] of Object.entries(state.commands))
      commands[id] = command;
    const contents = JSON.stringify({ version: state.version, commands });
    await writeFile(temp, contents, { mode: 0o600, flag: "wx" });
    await protect(temp);
    await atomicReplace(temp, this.path);
    return createHash("sha256").update(contents).digest("hex");
  }

  async list(): Promise<SavedCommand[]> {
    return (await this.listWithIssues()).commands;
  }

  async listWithIssues(): Promise<{
    commands: SavedCommand[];
    invalid: SavedCommandIssue[];
  }> {
    const state = await this.read();
    return {
      commands: Object.values(state.commands).sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
      invalid: Object.entries(state.invalid)
        .map(([id, entry]) => ({
          id,
          status: "invalid" as const,
          reason: entry.reason,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async resolve(idOrName: string): Promise<SavedCommand> {
    const commands = await this.list();
    const byId = commands.find((command) => command.id === idOrName);
    if (byId) return byId;
    const byName = commands.filter((command) => command.name === idOrName);
    if (byName.length === 1) return byName[0] as SavedCommand;
    if (byName.length > 1)
      throw new HomectlError(
        2,
        "Several saved commands have that name; use an id",
      );
    throw new HomectlError(2, "Saved command not found");
  }

  async save(input: unknown, id?: string): Promise<SavedCommand> {
    const fields = validateFields(input);
    return this.withLock(async () => {
      const state = await this.read();
      if (id === undefined && Object.keys(state.commands).length >= 4096)
        throw new HomectlError(
          3,
          "Saved command limit reached; remove one before adding another",
        );
      if (id !== undefined && !isValidSavedCommandId(id))
        throw new HomectlError(2, "Saved command id is invalid");
      const prior =
        id !== undefined && Object.hasOwn(state.commands, id)
          ? state.commands[id]
          : undefined;
      const invalidPrior = id !== undefined && Object.hasOwn(state.invalid, id);
      if (id !== undefined && !prior && !invalidPrior)
        throw new HomectlError(
          2,
          "Saved command not found; refresh and try again",
        );
      if (
        Object.values(state.commands).some(
          (command) =>
            command.id !== id &&
            command.name.toLocaleLowerCase() ===
              fields.name.toLocaleLowerCase(),
        )
      )
        throw new HomectlError(2, "A saved command already has that name");
      const now = new Date().toISOString();
      const command: SavedCommand = {
        schemaVersion: SAVED_COMMAND_VERSION,
        id: id ?? randomUUID(),
        ...fields,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
      state.commands[command.id] = command;
      delete state.invalid[command.id];
      await this.write(state);
      return command;
    });
  }

  async remove(idOrName: string): Promise<{ id: string }> {
    return this.withLock(async () => {
      const state = await this.read();
      if (Object.hasOwn(state.invalid, idOrName)) {
        delete state.invalid[idOrName];
        await this.write(state);
        return { id: idOrName };
      }
      const byId = Object.hasOwn(state.commands, idOrName)
        ? state.commands[idOrName]
        : undefined;
      const matches = byId
        ? [byId]
        : Object.values(state.commands).filter(
            (command) => command.name === idOrName,
          );
      if (matches.length === 0)
        throw new HomectlError(2, "Saved command not found");
      if (matches.length > 1)
        throw new HomectlError(
          2,
          "Several saved commands have that name; use an id",
        );
      const command = matches[0] as SavedCommand;
      delete state.commands[command.id];
      await this.write(state);
      return { id: command.id };
    });
  }

  async replaceFromRecords(
    records: Record<string, { value: unknown | null }>,
    expectedSavedCommands?: Record<string, { value: unknown | null }>,
  ): Promise<SavedCommand[]> {
    const available = await this.replaceFromRecordsWith(
      records,
      expectedSavedCommands,
      async () => {},
    );
    return available ? this.list() : [];
  }

  async replaceFromRecordsWith(
    records: Record<string, { value: unknown | null }>,
    expectedSavedCommands:
      | Record<string, { value: unknown | null }>
      | undefined,
    apply: (
      savedCommandsAvailable: boolean,
      preservedInvalidIds: string[],
    ) => Promise<void>,
  ): Promise<boolean> {
    let locked = false;
    try {
      return await this.withLock(async () => {
        locked = true;
        return this.replaceUnderLock(records, expectedSavedCommands, apply);
      });
    } catch (error) {
      // The lock or its private directory failed before anything was read.
      if (locked) throw error;
      return this.leaveSavedCommandsPending(error, [], apply);
    }
  }

  // Any saved-command failure before the write leaves saved commands pending
  // (file, state and clocks unchanged) while the other record types still apply.
  private async leaveSavedCommandsPending(
    error: unknown,
    preservedInvalidIds: string[],
    apply: (
      savedCommandsAvailable: boolean,
      preservedInvalidIds: string[],
    ) => Promise<void>,
  ): Promise<false> {
    const reason =
      error instanceof HomectlError
        ? error.message
        : ((error as NodeJS.ErrnoException).code ?? "unexpected error");
    console.warn(
      `Saved commands were left unchanged (${reason}); other peer sync records were applied.`,
    );
    await apply(false, preservedInvalidIds);
    return false;
  }

  private async replaceUnderLock(
    records: Record<string, { value: unknown | null }>,
    expectedSavedCommands:
      | Record<string, { value: unknown | null }>
      | undefined,
    apply: (
      savedCommandsAvailable: boolean,
      preservedInvalidIds: string[],
    ) => Promise<void>,
  ): Promise<boolean> {
    let current: DiskState;
    let commandMap: Record<string, SavedCommand>;
    let preservedInvalidIds: string[];
    try {
      const expected = expectedCommandMap(expectedSavedCommands);
      current = await this.read();
      const parsed = savedCommandsFromRecordsWithIssues(records);
      assertExpectedCommands(current, expected);
      preservedInvalidIds = Object.keys(current.invalid).map(
        (id) => `saved-command:${id}`,
      );
      const issueIds = new Set(parsed.issues.map((issue) => issue.id));
      const commands = [
        ...parsed.commands.filter(
          (command) => !Object.hasOwn(current.invalid, command.id),
        ),
        ...Object.entries(current.commands)
          .filter(([id]) => issueIds.has(`saved-command:${id}`))
          .map(([, command]) => command),
      ];
      commandMap = dictionary<SavedCommand>();
      for (const command of commands) commandMap[command.id] = command;
    } catch (error) {
      return this.leaveSavedCommandsPending(error, [], apply);
    }
    let writtenHash: string;
    try {
      writtenHash = await this.write({
        version: 1,
        commands: commandMap,
        invalid: current.invalid,
      });
    } catch (error) {
      return this.leaveSavedCommandsPending(error, preservedInvalidIds, apply);
    }
    try {
      await apply(true, preservedInvalidIds);
    } catch (error) {
      try {
        const contents = await readFile(this.path, "utf8");
        const currentHash = createHash("sha256").update(contents).digest("hex");
        if (currentHash === writtenHash) await this.write(current);
        else
          console.warn(
            "Saved commands changed during peer sync; rollback was skipped to preserve the newer file.",
          );
      } catch {
        console.warn(
          "Could not verify saved commands after peer sync failed; rollback was skipped to preserve any newer write.",
        );
      }
      throw error;
    }
    return true;
  }

  async validateReplacement(
    records: Record<string, { value: unknown | null }>,
    expectedSavedCommands?: Record<string, { value: unknown | null }>,
  ): Promise<void> {
    savedCommandsFromRecordsWithIssues(records);
    const expected = expectedCommandMap(expectedSavedCommands);
    await this.withLock(async () => {
      assertExpectedCommands(await this.read(), expected);
    });
  }
}
