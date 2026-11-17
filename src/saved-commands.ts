import { randomUUID } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { containsSecretMaterial, redactArgv } from "./control/redact";
import { atomicReplace, privateDirectory, protect } from "./platform";
import { HomectlError } from "./types";

export const SAVED_COMMAND_VERSION = 1 as const;
const HOST = /^[a-z][a-z0-9-]{0,62}$/;
const PARAMETER = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export type SavedCommandParameter = {
  name: string;
  description?: string;
};

// A saved command stores only a template. It never stores approvals or defaults
// for parameters; every invocation expands to a fresh argv and uses exec policy.
export type SavedCommand = {
  schemaVersion: typeof SAVED_COMMAND_VERSION;
  id: string;
  name: string;
  hosts: string[];
  argv: string[];
  parameters: SavedCommandParameter[];
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type SavedCommandInput = Omit<
  SavedCommand,
  "schemaVersion" | "id" | "createdAt" | "updatedAt" | "parameters"
> & { parameters?: SavedCommandParameter[] };
type SavedCommandFields = Omit<
  SavedCommand,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
>;

type DiskState = { version: 1; commands: Record<string, SavedCommand> };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new HomectlError(2, message);
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

export function savedCommandsFromRecords(
  records: Record<string, { value: unknown | null }>,
): SavedCommand[] {
  const commands: SavedCommand[] = [];
  for (const [key, version] of Object.entries(records)) {
    if (!key.startsWith("saved-command:") || version.value === null) continue;
    const id = key.slice("saved-command:".length);
    const command = validateStored(
      id.startsWith("copy-") && record(version.value)
        ? { ...version.value, id }
        : version.value,
      id,
    );
    if (id.startsWith("copy-") && !command.name.endsWith(" (copy)"))
      command.name = `${command.name} (copy)`;
    commands.push(command);
  }
  return commands.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
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
    await privateDirectory(dirname(this.path));
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await writeFile(this.lockPath, `${process.pid}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new HomectlError(5, "Saved commands cannot be locked");
        try {
          const info = await stat(this.lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS)
            await unlink(this.lockPath).catch(() => undefined);
        } catch {
          /* Lock disappeared while checking; retry. */
        }
        if (Date.now() > deadline)
          throw new HomectlError(5, "Saved commands are busy; retry");
        await Bun.sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async read(): Promise<DiskState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, commands: {} };
      throw new HomectlError(5, "Saved commands cannot be read");
    }
    try {
      const state = JSON.parse(text) as DiskState;
      if (state.version !== 1 || !record(state.commands)) throw new Error();
      const commands: Record<string, SavedCommand> = {};
      for (const [id, command] of Object.entries(state.commands))
        commands[id] = validateStored(command, id);
      return { version: 1, commands };
    } catch (error) {
      if (error instanceof HomectlError) throw error;
      throw new HomectlError(
        5,
        "Saved command file is corrupt; preserve it and investigate",
      );
    }
  }

  private async write(state: DiskState): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await protect(temp);
    await atomicReplace(temp, this.path);
  }

  async list(): Promise<SavedCommand[]> {
    const state = await this.read();
    return Object.values(state.commands).sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
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
  ): Promise<SavedCommand[]> {
    const commands = savedCommandsFromRecords(records);
    return this.withLock(async () => {
      const state: DiskState = {
        version: 1,
        commands: Object.fromEntries(
          commands.map((command) => [command.id, command]),
        ),
      };
      await this.write(state);
      return commands;
    });
  }
}
