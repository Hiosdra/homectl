// Persisted workspace state (homelab #21 §6). The server keeps its identity,
// a custody key that wraps client backup keys (D6A), the linked clients, their
// mirrored status and the retired clients' evidence. A client keeps its link to
// at most one server. Both files live in the broker's private state directory
// and hold link keys, so they are written atomically with owner-only permissions.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DecisionSource, EventEnvelope } from "../core/contracts";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";
import type { RestoreFileDigest } from "./restore-files";
import type {
  PendingSecretSummary,
  SecretIntentRecord,
} from "./secret-intents";

// What a client publishes about one operation awaiting its owner's decision.
// Requester narrative is untrusted and shown as such.
export interface PendingSummary {
  id: string;
  client: string;
  host: string;
  argv: string[];
  risk: string;
  // Short description of the effect, built from host, argv and classification.
  impact: string;
  fingerprint: string;
  reason: string;
  // Where the decision stands: "review" while the Auto Mode reviewer decides.
  // Absent from summaries sent by clients before this field existed.
  source?: DecisionSource;
  stepUp: boolean;
  humanOnly: boolean;
  expiresAt: number;
  narrative?: { untrusted: string };
}

// The backup status a client reports with each sync (server-side lag view).
export interface BackupReport {
  seq: number;
  lastAt?: number;
  lastError?: string;
}

// A host key the client's known_hosts lists as @revoked.
export interface HostKeyRef {
  type: string;
  blob: string;
}

// The revocations a client reports, taken at `at` on the client's clock.
// policyRules is absent when the client could not read its policy, so an
// unknown policy is never read as "every rule was revoked".
export interface Revocations {
  at: number;
  hostKeys: HostKeyRef[];
  policyRules?: string[];
}

// A restore delivered to a fresh client at pairing. Metadata only: the
// plaintext is decrypted and sent on each delivery and never stored. The grant
// is consumed only when the client acknowledges that it wrote the files.
export interface RestoreGrant {
  source: string; // the reset client's id (now revoked)
  seq: number;
  reason: string;
  issuedAt: number;
  expiresAt: number;
  // The source's revocations at the time it was reset, reapplied on delivery.
  revocations?: Revocations;
}

export type IntentDecision = "approve-once" | "deny-once";
export type IntentStatus = "queued" | "delivered" | "applied" | "refused";

// An owner decision made on the server for an operation on one client.
export interface Intent {
  id: string;
  operationId: string;
  fingerprint: string;
  decision: IntentDecision;
  stepUp: boolean;
  createdAt: number;
  expiresAt: number;
  status: IntentStatus;
  reason?: string;
}

export interface LinkedClient {
  name: string;
  platform: string;
  key: string; // hex link key
  joinedAt: number;
  lastSeenAt?: number;
  // Reported by the client: whether it accepts approvals from this server.
  remoteApproval?: boolean;
  vaultUnlocked?: boolean;
  wrappedBackupKey?: string;
  // gaps counts sequence jumps the client declared (its events were pruned
  // before they were mirrored, or the server copy was lost).
  mirror: { lastSeq: number; events: EventEnvelope[]; gaps?: number };
  pending: PendingSummary[];
  intents: Intent[];
  pendingSecrets?: PendingSecretSummary[];
  secretIntents?: SecretIntentRecord[];
  backupReport?: BackupReport;
  // Set by an owner; delivered once in the next sync reply.
  backupRequested?: boolean;
  revocations?: Revocations;
  restore?: RestoreGrant;
}

// Why a client left the server. Each one keeps the client's evidence.
export type RetireCause = "removed" | "restore" | "declined";

// A client that left the server: read-only evidence of its last mirror, and
// its wrapped backup key so its history stays restorable. Its id is in
// `removed`, so it can never link again.
export interface RetiredClient {
  name: string;
  platform: string;
  joinedAt: number;
  retiredAt: number;
  cause: RetireCause;
  wrappedBackupKey?: string;
  revocations?: Revocations;
  // False once the mirror was dropped to keep the history bounded. The key
  // is kept either way.
  historyKept: boolean;
  mirror: { lastSeq: number; events: EventEnvelope[]; gaps: number };
  pending: PendingSummary[];
}

export interface ServerState {
  version: 1;
  id: string;
  name: string;
  custody: string; // hex, wraps client backup keys
  clients: Record<string, LinkedClient>;
  // Removed clients are remembered so a stale link can never come back.
  removed: string[];
  retired?: Record<string, RetiredClient>;
}

export interface ClientLink {
  version: 1;
  id: string;
  name: string;
  server?: {
    id: string;
    name: string;
    address: string;
    key: string; // hex link key
    joinedAt: number;
    remoteApproval: boolean;
  };
  eventsAcked: number;
  // Recently applied or refused server intents; replays are ignored.
  seenIntents: string[];
  backup: {
    key: string; // hex client backup key
    seq: number;
    parent: string | null;
    lastAt?: number;
    lastError?: string;
  };
  // The server confirmed it holds this link's wrapped backup key.
  backupKeyRegistered?: boolean;
  // Recorded before file installation. A retry verifies every file before it
  // acknowledges the restore. Older receipts have no digests.
  restore?: { seq: number; files: string[]; expected?: RestoreFileDigest[] };
  // The server may still hold a restore for this device: check again on sync.
  restorePending?: boolean;
  lastSyncAt?: number;
  lastSyncError?: string;
}

const MAX_MIRRORED_EVENTS = 500;
export const MAX_SEEN_INTENTS = 512;

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readFile(path, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HomectlError(5, `Workspace state is corrupt: ${path}`);
  }
}

async function writeJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await atomicReplace(temp, path);
}

// In-process serialisation; one daemon owns each file.
class JsonFile<T> {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    private readonly initial: () => T,
  ) {}
  async read(): Promise<T> {
    await this.tail.catch(() => undefined);
    return (await readJson<T>(this.path)) ?? this.initial();
  }
  update<R>(fn: (value: T) => R | Promise<R>): Promise<R> {
    const next = this.tail.then(async () => {
      const value = (await readJson<T>(this.path)) ?? this.initial();
      const result = await fn(value);
      await writeJson(this.path, value);
      return result;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function serverStateFile(state: string) {
  return new JsonFile<ServerState>(
    join(state, "workspace-server.json"),
    () => ({
      version: 1,
      id: randomUUID(),
      name: hostname().slice(0, 100) || "homectl server",
      custody: randomBytes(32).toString("hex"),
      clients: {},
      removed: [],
    }),
  );
}

// A link identity: a new id and a new backup key. A device gets a new one when
// its old identity must never be used again (a declined restore).
export function freshIdentity(): Pick<ClientLink, "id" | "backup"> {
  return {
    id: randomUUID(),
    backup: {
      key: randomBytes(32).toString("hex"),
      seq: 0,
      parent: null,
    },
  };
}

export function clientLinkFile(state: string) {
  return new JsonFile<ClientLink>(join(state, "workspace-link.json"), () => ({
    version: 1,
    name: hostname().slice(0, 100) || "homectl client",
    eventsAcked: 0,
    seenIntents: [],
    ...freshIdentity(),
  }));
}

export type ServerStateFile = ReturnType<typeof serverStateFile>;

// Client ids are link UUIDs; lookups use own properties only, so a name such
// as "constructor" can never resolve to an object prototype.
export function linked(
  state: ServerState,
  id: string,
): LinkedClient | undefined {
  return Object.hasOwn(state.clients, id) ? state.clients[id] : undefined;
}
export type ClientLinkFile = ReturnType<typeof clientLinkFile>;

// Appends in-order events to a client's mirror. Returns the new last seq, or
// a gap when the batch does not continue the mirrored sequence.
export function ingestEvents(
  mirror: LinkedClient["mirror"],
  events: EventEnvelope[],
  // The client's cursor: the last seq it believes is mirrored. A cursor ahead
  // of the mirror is a declared gap; the mirror continues from it rather than
  // refusing every later event.
  after?: number,
): { lastSeq: number; gap: boolean } {
  if (after !== undefined && after > mirror.lastSeq) {
    if (mirror.lastSeq !== 0 || after > 0) mirror.gaps = (mirror.gaps ?? 0) + 1;
    mirror.lastSeq = after;
  }
  for (const event of events) {
    if (event.seq <= mirror.lastSeq) continue;
    if (mirror.lastSeq !== 0 && event.seq !== mirror.lastSeq + 1)
      return { lastSeq: mirror.lastSeq, gap: true };
    mirror.events.push(event);
    mirror.lastSeq = event.seq;
  }
  if (mirror.events.length > MAX_MIRRORED_EVENTS)
    mirror.events.splice(0, mirror.events.length - MAX_MIRRORED_EVENTS);
  return { lastSeq: mirror.lastSeq, gap: false };
}

// Backup ids follow CLIENT_ID_PATTERN; link ids are UUIDs.
export const backupClientId = (linkId: string) => `c-${linkId}`;
