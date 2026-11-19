// Read-only check of a 0.2 database before migration. Reports names and problem
// descriptions only; it never returns or logs values.
import type { CredentialSource } from "./credentials";
import {
  classify,
  managedEntries,
  readSshKey,
  SSH_ATTACHMENT,
  text,
  title,
} from "./entries";
import { openDatabase, type VaultDatabase } from "./kdbx";

export type LegacyReport = {
  opens: boolean;
  sshKeys: string[];
  problems: string[];
};

const TOKEN_ID = /^[^\s=!]+@[^\s=!]+![^\s=!]+$/;

export async function inspectLegacy(
  path: string,
  password: CredentialSource,
): Promise<LegacyReport> {
  let opened: VaultDatabase;
  try {
    opened = await openDatabase(path, password);
  } catch {
    return {
      opens: false,
      sshKeys: [],
      problems: ["Database could not be opened with the given password"],
    };
  }
  const problems: string[] = [];
  const sshKeys: string[] = [];
  const managed = managedEntries(opened.db);
  const counts = new Map<string, number>();
  for (const entry of managed)
    counts.set(title(entry), (counts.get(title(entry)) ?? 0) + 1);
  for (const [name, count] of counts)
    if (count > 1) problems.push(`Duplicate entry name: ${name}`);
  for (const entry of managed) {
    const name = title(entry);
    if (entry.binaries.has(SSH_ATTACHMENT)) {
      try {
        readSshKey(entry);
        sshKeys.push(name);
      } catch {
        problems.push(`SSH key cannot be decoded: ${name}`);
      }
    } else if (classify(entry) === "api-token") {
      const tokenId = text(entry.fields.get("UserName"));
      const secret = text(entry.fields.get("Password"));
      if (!TOKEN_ID.test(tokenId) || !/^\S+$/.test(secret))
        problems.push(`API token entry is malformed: ${name}`);
    } else {
      problems.push(`Entry is not a recognised homectl layout: ${name}`);
    }
  }
  return { opens: true, sshKeys: sshKeys.sort(), problems };
}
