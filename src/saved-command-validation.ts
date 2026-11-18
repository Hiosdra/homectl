import {
  containsRedactionMarker,
  containsSecretMaterial,
  redactArgv,
} from "./control/redact";
import {
  SAVED_COMMAND_VERSION,
  type SavedCommand,
} from "./saved-command-types";
import { HomectlError } from "./types";

const HOST = /^[a-z][a-z0-9-]{0,62}$/;
const PARAMETER = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export type SavedCommandFields = Omit<
  SavedCommand,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new HomectlError(2, message);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isReservedSavedCommandName(value: string): boolean {
  return RESERVED_NAMES.has(value.toLocaleLowerCase());
}

export function isValidSavedCommandId(value: string): boolean {
  return ID.test(value) && !isReservedSavedCommandName(value);
}

export function validateFields(input: unknown): SavedCommandFields {
  if (!record(input)) return fail("Saved command must be an object");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80 || isReservedSavedCommandName(name))
    fail("Name must be 1 to 80 characters and not a reserved name");
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
            item.description.length > 160)) ||
        (item.secret !== undefined && typeof item.secret !== "boolean"),
    )
  )
    fail(
      "Parameters need lowercase names and descriptions up to 160 characters",
    );
  const parameters = (input.parameters ?? []).map((item) => ({
    name: item.name as string,
    ...(typeof item.description === "string"
      ? { description: item.description }
      : {}),
    ...(typeof item.secret === "boolean" ? { secret: item.secret } : {}),
  }));
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

export function validateStored(
  value: unknown,
  expectedId?: string,
): SavedCommand {
  if (!record(value) || value.schemaVersion !== SAVED_COMMAND_VERSION)
    fail("Unsupported saved command version");
  const id = typeof value.id === "string" ? value.id : "";
  if (
    !isValidSavedCommandId(id) ||
    (expectedId !== undefined && id !== expectedId)
  )
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
