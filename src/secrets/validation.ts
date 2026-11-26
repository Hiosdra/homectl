// Input validation for the broker. Every function takes `unknown` and returns a
// normalized value or throws. Usage errors are code 2; refusals that must not
// reveal details to the caller are code 3 with fixed messages.

import {
  CLIENT_ID_PATTERN,
  OWNER,
  type SecretField,
  type SecretFieldKind,
} from "../core/contracts";
import { HomectlError } from "../types";
import {
  DEFAULT_REQUEST_TTL_MS,
  FIELD_KINDS,
  FIELD_NAME_PATTERN,
  MAX_FIELDS,
  MAX_PURPOSE_CHARS,
  MAX_REQUEST_TTL_MS,
  MAX_VALUE_CHARS,
  MIN_REQUEST_TTL_MS,
  SAVE_NAME_PATTERN,
  SECRET_ID_PATTERN,
} from "./types";

export function usageError(message: string): HomectlError {
  return new HomectlError(2, message);
}

export function refusal(message: string): HomectlError {
  return new HomectlError(3, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// True for C0 controls and DEL. Used for values that must stay one line.
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isFieldKind(value: unknown): value is SecretFieldKind {
  return typeof value === "string" && (FIELD_KINDS as string[]).includes(value);
}

export function validateClient(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CLIENT_ID_PATTERN.test(value) ||
    value === OWNER
  )
    throw usageError("invalid client id");
  return value;
}

export function validateTask(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    hasControlCharacter(value)
  )
    throw usageError("invalid task id");
  return value;
}

export function validatePurpose(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PURPOSE_CHARS ||
    value.trim().length === 0 ||
    hasControlCharacter(value)
  )
    throw usageError(
      `purpose must be 1 to ${MAX_PURPOSE_CHARS} printable characters`,
    );
  return value;
}

export function validateRequestTtl(value: unknown): number {
  if (value === undefined) return DEFAULT_REQUEST_TTL_MS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_REQUEST_TTL_MS ||
    value > MAX_REQUEST_TTL_MS
  )
    throw usageError("requestTtlMs is out of range");
  return value;
}

export function validateAdmin(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw usageError("admin must be a boolean");
  return value;
}

export function normalizeFields(value: unknown): SecretField[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FIELDS)
    throw usageError(`fields must list 1 to ${MAX_FIELDS} entries`);
  const list: readonly unknown[] = value;
  const seen = new Set<string>();
  return list.map((item): SecretField => {
    if (!isRecord(item)) throw usageError("each field must be an object");
    const name = item.name;
    if (typeof name !== "string" || !FIELD_NAME_PATTERN.test(name))
      throw usageError("invalid field name");
    if (seen.has(name)) throw usageError("field names must be unique");
    seen.add(name);
    const label = item.label === undefined ? name : item.label;
    if (
      typeof label !== "string" ||
      label.length < 1 ||
      label.length > 120 ||
      hasControlCharacter(label)
    )
      throw usageError("invalid field label");
    const kind = item.kind === undefined ? "password" : item.kind;
    if (!isFieldKind(kind)) throw usageError("invalid field kind");
    return { name, label, kind };
  });
}

// Values must cover exactly the declared fields, each 1 to 16384 characters.
export function validateValues(
  fields: readonly SecretField[],
  value: unknown,
): Record<string, string> {
  if (!isRecord(value)) throw usageError("values must be an object");
  const declared = new Set(fields.map((field) => field.name));
  const supplied = Object.keys(value);
  if (
    supplied.length !== declared.size ||
    supplied.some((name) => !declared.has(name))
  )
    throw usageError("values must cover exactly the declared fields");
  const out: Record<string, string> = {};
  for (const name of declared) {
    const item = value[name];
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > MAX_VALUE_CHARS
    )
      throw usageError(
        `value for field ${name} must be 1 to ${MAX_VALUE_CHARS} characters`,
      );
    out[name] = item;
  }
  return out;
}

export function validateSaveName(value: unknown): string {
  if (typeof value !== "string" || !SAVE_NAME_PATTERN.test(value))
    throw usageError("invalid save name");
  return value;
}

export function validateSecretId(value: unknown): string {
  if (typeof value !== "string" || !SECRET_ID_PATTERN.test(value))
    throw usageError("invalid secret id");
  return value;
}
