import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDirectoryOnce, withFileLock } from "./control/file-lock";
import {
  containsRedactionMarker,
  containsSecretMaterial,
  redactArgv,
} from "./control/redact";
import { atomicReplace, protect } from "./platform";
import { parseSavedCommandsFromRecordsWithIssues } from "./saved-command-records";
import {
  SAVED_COMMAND_VERSION,
  type SavedCommand,
  type SavedCommandIssue,
  type SavedCommandParameter,
  type SavedCommandRecordIssue,
} from "./saved-command-types";
import { HomectlError } from "./types";

export {
  SAVED_COMMAND_VERSION,
  type SavedCommand,
  type SavedCommandInput,
  type SavedCommandIssue,
  type SavedCommandParameter,
  type SavedCommandRecordIssue,
} from "./saved-command-types";

const HOST = /^[a-z][a-z0-9-]{0,62}$/;
const PARAMETER = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

// A saved command stores only a template. It never stores approvals or defaults
// for parameters; every invocation expands to a fresh argv and uses exec policy.
type SavedCommandFields = Omit<
  SavedCommand,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
>;

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

function fail(message: string): never {
  throw new HomectlError(2, message);
}

function stableCommandMap(commands: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(commands)
      .sort()
      .map((id) => [id, commands[id]]),
  );
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateFields(input: unknown): SavedCommandFields {
  if (!record(input)) return fail("Saved command must be an object");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) fail("Name must be 1 to 80 characters");
  if (
    !Array.isArray(input.hosts) ||
    input.hosts.length < 1 ||
    input.hosts.length > 64 ||
    input.hosts.some((host) => typeof host !== "string" || !HOST.test(host))
  )
    fail("Choose one or more valid target hosts");
  const hosts = [...new Set(input.hosts as string[])];
  if (hosts.length !== input.hosts.length)
    fail("Target hosts must not contain duplicates");
  if (
    !Array.isArray(input.argv) ||
    input.argv.length < 1 ||
    input.argv.length > 64 ||
    input.argv.some(
      (arg) =>
        typeof arg !== "string" ||
        arg.length < 1 ||
        arg.length > 4096 ||
        arg.includes("\0"),
    )
  )
    fail("Command argv must contain 1 to 64 non-empty arguments");
  const argv = input.argv as string[];
  if (containsRedactionMarker(argv))
    fail("Redacted arguments cannot be saved as a command");
  if (
    (input.parameters !== undefined &&
      (!Array.isArray(input.parameters) || input.parameters.length > 32)) ||
    (input.parameters ?? []).some(
      (item) =>
        !record(item) ||
        typeof item.name !== "string" ||
        !PARAMETER.test(item.name) ||
        (item.description !== undefined &&
          (typeof item.description !== "string" ||
            item.description.length > 160)),
    )
  )
    fail(
      "Parameters need lowercase names and descriptions up to 160 characters",
    );
  const parameters = (input.parameters ?? []) as SavedCommandParameter[];
  const names = new Set(parameters.map((parameter) => parameter.name));
  if (names.size !== parameters.length) fail("Parameter names must be unique");
  const redacted = redactArgv(argv);
  for (const [index, argument] of argv.entries()) {
    if (redacted[index] === argument) continue;
    const placeholder = /^\{\{([a-z][a-z0-9_-]{0,31})\}\}$/.exec(argument);
    const assignment = /^([^=]+)=\{\{([a-z][a-z0-9_-]{0,31})\}\}$/.exec(
      argument,
    );
    const flag =
      index > 0 &&
      argv[index - 1]?.startsWith("-") &&
      /(?:password|passwd|token|secret|api[_-]?key|authorization)/i.test(
        argv[index - 1] ?? "",
      );
    const declared = placeholder?.[1] ?? assignment?.[2];
    if (!declared || !names.has(declared) || !(flag || assignment))
      fail(
        "Secret-like arguments cannot be stored; declare a parameter and use its placeholder",
      );
  }
  const used = new Set<string>();
  for (const arg of argv) {
    const remaining = arg.replace(
      /\{\{([a-z][a-z0-9_-]{0,31})\}\}/g,
      (_, key: string) => {
        used.add(key);
        return "";
      },
    );
    if (remaining.includes("{{") || remaining.includes("}}"))
      fail("Use parameters as {{name}} in an argument");
  }
  for (const parameter of parameters)
    if (!used.has(parameter.name))
      fail(`Parameter {{${parameter.name}}} is not used in argv`);
  for (const name of used)
    if (!names.has(name)) fail(`Declare parameter ${name} before saving`);
  const description =
    input.description === undefined
      ? undefined
      : typeof input.description === "string"
        ? input.description.trim()
        : fail("Description must be text");
  if (description && description.length > 500)
    fail("Description must be 500 characters or fewer");
  if (
    containsSecretMaterial(
      JSON.stringify({ name, hosts, argv, parameters, description }),
    )
  )
    fail("Secret-like material cannot be stored in a saved command");
  return {
    name,
    hosts,
    argv: [...argv],
    parameters: structuredClone(parameters),
    ...(description ? { description } : {}),
  };
}

function validateStored(value: unknown, expectedId?: string): SavedCommand {
  if (!record(value) || value.schemaVersion !== SAVED_COMMAND_VERSION)
    fail("Unsupported saved command version");
  const id = typeof value.id === "string" ? value.id : "";
  if (!ID.test(id) || (expectedId !== undefined && id !== expectedId))
    fail("Saved command id does not match its record");
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt))
    fail("Saved command timestamps are invalid");
  const fields = validateFields(value);
  return {
    schemaVersion: SAVED_COMMAND_VERSION,
    id,
    ...fields,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
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
        return { version: 1, commands: {}, invalid: {} };
      throw new HomectlError(5, "Saved commands cannot be read");
    }
    try {
      const state = JSON.parse(text) as DiskState;
      if (state.version !== 1 || !record(state.commands)) throw new Error();
      const commands: Record<string, SavedCommand> = {};
      const invalid: Record<string, InvalidSavedCommandRecord> = {};
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

  private async write(state: DiskState): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const commands = Object.fromEntries([
      ...Object.entries(state.invalid)
        .filter(([id]) => !Object.hasOwn(state.commands, id))
        .map(([id, entry]) => [id, entry.value]),
      ...Object.entries(state.commands),
    ]);
    await writeFile(
      temp,
      JSON.stringify({ version: state.version, commands }),
      { mode: 0o600, flag: "wx" },
    );
    await protect(temp);
    await atomicReplace(temp, this.path);
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
      const prior = id === undefined ? undefined : state.commands[id];
      if (id !== undefined && !prior)
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
      await this.write(state);
      return command;
    });
  }

  async remove(idOrName: string): Promise<SavedCommand> {
    return this.withLock(async () => {
      const state = await this.read();
      const byId = state.commands[idOrName];
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
      return command;
    });
  }

  async replaceFromRecords(
    records: Record<string, { value: unknown | null }>,
    expectedSavedCommands?: Record<string, { value: unknown | null }>,
  ): Promise<SavedCommand[]> {
    const parsed = savedCommandsFromRecordsWithIssues(records);
    return this.withLock(async () => {
      const current = await this.read();
      if (expectedSavedCommands) {
        const expected = Object.fromEntries(
          Object.entries(expectedSavedCommands)
            .filter(
              ([id, version]) =>
                id.startsWith("saved-command:") && version.value !== null,
            )
            .map(([id, version]) => {
              const commandId = id.slice("saved-command:".length);
              return [commandId, validateStored(version.value, commandId)];
            }),
        );
        if (stableCommandMap(current.commands) !== stableCommandMap(expected))
          throw new HomectlError(
            3,
            "Saved commands changed since the sync preview; refresh before applying",
          );
      }
      const issueIds = new Set(parsed.issues.map((issue) => issue.id));
      const commands = [
        ...parsed.commands,
        ...Object.entries(current.commands)
          .filter(([id]) => issueIds.has(`saved-command:${id}`))
          .map(([, command]) => command),
      ];
      const state: DiskState = {
        version: 1,
        commands: Object.fromEntries(
          commands.map((command) => [command.id, command]),
        ),
        invalid: current.invalid,
      };
      await this.write(state);
      return commands;
    });
  }
}
