import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { HomectlError } from "../types";
import { isoTime } from "./canonical";
import type {
  ClientAuthenticator,
  ClientIdentity,
  ClientRecord,
  ClientView,
  Scope,
} from "./types";
import { SCOPES } from "./types";

// Actor names reserved for the system and the private local operator.
export const RESERVED_CLIENT_IDS: ReadonlySet<string> = new Set([
  "local-operator",
  "control-plane",
]);
const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const TOKEN_PATTERN = /^hct_[A-Za-z0-9_-]{43}$/;

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function generateToken(): string {
  return `hct_${randomBytes(32).toString("base64url")}`;
}

export function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function identityOf(record: ClientRecord): ClientIdentity {
  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    hosts: [...record.hosts],
  };
}

export function clientView(record: ClientRecord): ClientView {
  return {
    id: record.id,
    name: record.name,
    scopes: [...record.scopes],
    hosts: [...record.hosts],
    createdAt: isoTime(record.createdAt),
    revoked: record.revokedAt !== undefined,
  };
}

export function hasScope(client: ClientIdentity, scope: Scope): boolean {
  return client.scopes.includes(scope);
}

export function permitsHost(client: ClientIdentity, host: string): boolean {
  return client.hosts.includes(host);
}

export function validateClientInput(input: Record<string, unknown>): {
  id: string;
  name: string;
  scopes: Scope[];
  hosts: string[];
} {
  const invalid = (message: string) => new HomectlError(2, message);
  if (typeof input.id !== "string" || !ID_PATTERN.test(input.id))
    throw invalid("Client id must be lowercase letters, digits and dashes");
  if (RESERVED_CLIENT_IDS.has(input.id)) throw invalid("Client id is reserved");
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 80 ||
    hasControlCharacter(input.name)
  )
    throw invalid("Client name must be 1 to 80 printable characters");
  if (!Array.isArray(input.scopes) || input.scopes.length === 0)
    throw invalid("Client requires at least one scope");
  const scopes: Scope[] = [];
  for (const scope of input.scopes) {
    if (!SCOPES.includes(scope as Scope) || scopes.includes(scope as Scope))
      throw invalid("Unknown or duplicate scope");
    scopes.push(scope as Scope);
  }
  if (!Array.isArray(input.hosts) || input.hosts.length === 0)
    throw invalid("Client requires at least one explicit host grant");
  if (input.hosts.length > 256) throw invalid("Too many host grants");
  const hosts: string[] = [];
  for (const host of input.hosts) {
    if (
      typeof host !== "string" ||
      !ID_PATTERN.test(host) ||
      hosts.includes(host)
    )
      throw invalid("Host grants must be unique inventory host names");
    hosts.push(host);
  }
  return { id: input.id, name: input.name.trim(), scopes, hosts };
}

// File-backed registry of client identities. Only token digests are stored.
// Reads happen on every request, so revocation takes effect immediately.
export class ClientRegistry implements ClientAuthenticator {
  constructor(readonly path: string) {}

  async load(): Promise<Record<string, ClientRecord>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new HomectlError(5, "Client registry cannot be read");
    }
    try {
      const file = JSON.parse(text) as {
        version: number;
        clients: Record<string, ClientRecord>;
      };
      if (file.version !== 1 || !file.clients) throw new Error("shape");
      return file.clients;
    } catch {
      throw new HomectlError(
        5,
        "Client registry is corrupt; restore it before continuing",
      );
    }
  }

  // Callers hold the control-plane lock.
  async save(clients: Record<string, ClientRecord>): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, clients }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, this.path);
  }

  // Compares the digest against every non-revoked client without returning
  // early, so timing does not reveal which record matched.
  async authenticate(
    credential: string | undefined,
  ): Promise<ClientIdentity | null> {
    if (typeof credential !== "string" || !TOKEN_PATTERN.test(credential))
      return null;
    const digest = tokenDigest(credential);
    const clients = await this.load();
    let match: ClientRecord | undefined;
    for (const record of Object.values(clients)) {
      const stored = Buffer.from(record.tokenHash, "hex");
      const equal =
        stored.length === digest.length && timingSafeEqual(stored, digest);
      if (equal && record.revokedAt === undefined) match = record;
    }
    return match ? identityOf(match) : null;
  }
}
