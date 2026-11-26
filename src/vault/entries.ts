// Entry logic over an opened KDBX tree. Pure with respect to files and sessions:
// session.ts decides who may call these, this module decides what they do.
import { createPrivateKey } from "node:crypto";
import * as kdbx from "kdbxweb";
import { decodeKey, publicBlob } from "../session/agent";
import { HomectlError } from "../types";
import { ensureGroup, GROUPS, groupPath, inRecycleBin } from "./groups";
import {
  ADMIN_TAG,
  type EntryKind,
  type EntryMeta,
  type SshKeyMaterial,
} from "./types";

export const SSH_ATTACHMENT = "id_ed25519";
const LEGACY_PREFIX = "homectl-";
const NAME_LIMIT = 128;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/;
const VALUE_LIMIT = 16 * 1024;
const TAG_LIMIT = 32;

export function text(value: kdbx.KdbxEntryField | undefined): string {
  return typeof value === "string" ? value : (value?.getText() ?? "");
}

export function title(entry: kdbx.KdbxEntry): string {
  return text(entry.fields.get("Title"));
}

// Canonical 8-4-4-4-12 form of the KDBX entry UUID (stored as base64).
export function canonicalId(uuid: kdbx.KdbxUuid): string {
  const hex = Buffer.from(uuid.id, "base64").toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function isAdmin(entry: kdbx.KdbxEntry): boolean {
  return entry.tags.includes(ADMIN_TAG);
}

// Every entry outside the recycle bin.
export function liveEntries(db: kdbx.Kdbx): kdbx.KdbxEntry[] {
  return db.groups
    .flatMap((group) => [...group.allEntries()])
    .filter((entry) => !inRecycleBin(db, entry));
}

// Entries homectl manages: 0.2 "homectl-<name>" entries anywhere, plus anything
// under the homectl group tree.
export function managedEntries(db: kdbx.Kdbx): kdbx.KdbxEntry[] {
  return liveEntries(db).filter((entry) => {
    const path = groupPath(entry);
    return (
      title(entry).startsWith(LEGACY_PREFIX) ||
      path === "homectl" ||
      path.startsWith("homectl/")
    );
  });
}

export function classify(entry: kdbx.KdbxEntry): EntryKind {
  if (entry.binaries.has(SSH_ATTACHMENT)) return "ssh-key";
  const path = groupPath(entry);
  if (path === GROUPS.api || path.startsWith(`${GROUPS.api}/`))
    return "api-token";
  if (path === GROUPS.secrets || path.startsWith(`${GROUPS.secrets}/`))
    return "secret";
  // 0.2 Proxmox token layout: UserName holds the token id, Password the secret.
  if (
    title(entry).startsWith(LEGACY_PREFIX) &&
    text(entry.fields.get("UserName")) !== "" &&
    text(entry.fields.get("Password")) !== ""
  )
    return "api-token";
  return "other";
}

export function groupForKind(kind: EntryKind): string {
  if (kind === "ssh-key") return GROUPS.ssh;
  if (kind === "api-token") return GROUPS.api;
  return GROUPS.secrets;
}

export function metaOf(entry: kdbx.KdbxEntry): EntryMeta {
  return {
    id: canonicalId(entry.uuid),
    name: title(entry),
    group: groupPath(entry),
    kind: classify(entry),
    tags: entry.tags.slice(),
    admin: isAdmin(entry),
    updatedAt: entry.lastModTime,
  };
}

// Exact-title lookup. Duplicate titles are refused rather than guessed at.
export function findUnique(
  entries: readonly kdbx.KdbxEntry[],
  name: string,
): kdbx.KdbxEntry | undefined {
  const matches = entries.filter((entry) => title(entry) === name);
  if (matches.length > 1)
    throw new HomectlError(
      2,
      "Duplicate entry names; resolve in KeePassXC first",
    );
  return matches[0];
}

export function findById(
  entries: readonly kdbx.KdbxEntry[],
  id: string,
): kdbx.KdbxEntry | undefined {
  return entries.find((entry) => canonicalId(entry.uuid) === id);
}

export function unwrapBinary(
  binary: kdbx.KdbxBinary | kdbx.KdbxBinaryWithHash,
): kdbx.KdbxBinary {
  return kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
}

function binaryBytes(
  binary: kdbx.KdbxBinary | kdbx.KdbxBinaryWithHash,
): Buffer {
  const value = unwrapBinary(binary);
  return Buffer.from(
    value instanceof kdbx.ProtectedValue
      ? value.getBinary()
      : new Uint8Array(value),
  );
}

// Decodes the 0.2 layout: an encrypted PKCS#8 PEM (passphrase in Password), or
// an unencrypted PEM/OpenSSH key. Failures never include key material.
export function readSshKey(entry: kdbx.KdbxEntry): SshKeyMaterial {
  const attachment = entry.binaries.get(SSH_ATTACHMENT);
  if (!attachment) throw new HomectlError(2, "Entry has no SSH key");
  const bytes = binaryBytes(attachment);
  let pem: Buffer | undefined;
  try {
    const key = bytes.toString().includes("BEGIN ENCRYPTED PRIVATE KEY")
      ? createPrivateKey({
          key: bytes,
          passphrase: text(entry.fields.get("Password")),
        })
      : decodeKey(bytes);
    pem = Buffer.from(key.export({ type: "pkcs8", format: "pem" }));
    return {
      privateKey: new Uint8Array(pem),
      publicKey: `ssh-ed25519 ${publicBlob(key).toString("base64")}`,
    };
  } catch {
    throw new HomectlError(5, "SSH key entry could not be decoded");
  } finally {
    bytes.fill(0);
    pem?.fill(0);
  }
}

// Secret fields as strings. Title is metadata, and empty standard fields that
// KDBX adds to every new entry carry no value, so both are left out.
export function readFields(entry: kdbx.KdbxEntry): Record<string, string> {
  return Object.fromEntries(
    [...entry.fields]
      .map(([key, value]) => [key, text(value)] as const)
      .filter(([key, value]) => key !== "Title" && value !== ""),
  );
}

export function validateName(name: string): void {
  // Printable text only: no control characters, no padding, bounded length.
  const printable = [...name].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  if (
    name.length === 0 ||
    name.length > NAME_LIMIT ||
    !printable ||
    name.trim() !== name
  )
    throw new HomectlError(2, "Invalid entry name");
}

export function normalizeTags(tags: readonly string[]): string[] {
  if (tags.length > TAG_LIMIT) throw new HomectlError(2, "Too many tags");
  for (const tag of tags)
    if (!TAG_PATTERN.test(tag)) throw new HomectlError(2, "Invalid tag");
  return [...new Set(tags)];
}

export function validateValues(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (key === "Title" || !FIELD_PATTERN.test(key))
      throw new HomectlError(2, "Invalid field name");
    if (typeof value !== "string" || value.length > VALUE_LIMIT)
      throw new HomectlError(2, "Invalid field value");
  }
}

function writeFields(
  entry: kdbx.KdbxEntry,
  name: string,
  values: Record<string, string>,
): void {
  entry.fields.clear();
  entry.fields.set("Title", name);
  for (const [key, value] of Object.entries(values))
    entry.fields.set(key, kdbx.ProtectedValue.fromString(value));
}

export type SecretOptions = { tags?: string[]; group?: string };

// Creates or replaces a secret entry. Callers have already checked privilege.
// All validation runs before the first mutation, so a rejected call changes nothing.
export function upsertSecret(
  db: kdbx.Kdbx,
  name: string,
  values: Record<string, string>,
  options: SecretOptions,
): kdbx.KdbxEntry {
  validateName(name);
  validateValues(values);
  const tags =
    options.tags === undefined ? undefined : normalizeTags(options.tags);
  const existing = findUnique(managedEntries(db), name);
  if (existing) {
    if (existing.binaries.size > 0)
      throw new HomectlError(
        2,
        "SSH key entries cannot be changed by putSecret",
      );
    if (options.group !== undefined && options.group !== groupPath(existing))
      throw new HomectlError(
        2,
        "Entry group cannot change; remove and recreate it",
      );
    existing.pushHistory();
    writeFields(existing, name, values);
    if (tags !== undefined) existing.tags = tags;
    existing.times.update();
    return existing;
  }
  const group = ensureGroup(db, options.group ?? GROUPS.secrets);
  const entry = db.createEntry(group);
  writeFields(entry, name, values);
  entry.tags = tags ?? [];
  entry.times.update();
  return entry;
}

// Copies one entry, with its fields, attachments and tags, into `group` of
// another database. The source is only read.
export async function copyEntry(
  source: kdbx.KdbxEntry,
  target: kdbx.Kdbx,
  group: kdbx.KdbxGroup,
): Promise<kdbx.KdbxEntry> {
  const entry = target.createEntry(group);
  for (const [key, value] of source.fields)
    entry.fields.set(key, typeof value === "string" ? value : value.clone());
  for (const [name, binary] of source.binaries) {
    const value = unwrapBinary(binary);
    entry.binaries.set(
      name,
      await target.createBinary(
        value instanceof kdbx.ProtectedValue ? value.clone() : value.slice(0),
      ),
    );
  }
  entry.tags = source.tags.slice();
  entry.times.update();
  return entry;
}
