// Persisted workspace state (homelab #21 §6). The server keeps its identity,
// a custody key that wraps client backup keys (D6A), the linked clients and
// their mirrored status. A client keeps its link to at most one server. Both
// files live in the broker's private state directory and hold link keys, so
// they are written atomically with owner-only permissions.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "../core/contracts";
import { atomicReplace } from "../platform";
import { HomectlError } from "../types";

// What a client publishes about one operation awaiting its owner's decision.
// Requester narrative is untrusted and shown as such.
export interface PendingSummary {
  id: string;
  client: string;
  host: string;
  argv: string[];
  risk: string;
  fingerprint: string;
  reason: string;
  stepUp: boolean;
  humanOnly: boolean;
  expiresAt: number;
  narrative?: { untrusted: string };
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
  mirror: { lastSeq: number; events: EventEnvelope[] };
  pending: PendingSummary[];
  intents: Intent[];
}

export interface ServerState {
  version: 1;
  id: string;
  name: string;
  custody: string; // hex, wraps client backup keys
  clients: Record<string, LinkedClient>;
  // Removed clients are remembered so a stale link can never come back.
  removed: string[];
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

export function clientLinkFile(state: string) {
  return new JsonFile<ClientLink>(join(state, "workspace-link.json"), () => ({
    version: 1,
    id: randomUUID(),
    name: hostname().slice(0, 100) || "homectl client",
    eventsAcked: 0,
    seenIntents: [],
    backup: { key: randomBytes(32).toString("hex"), seq: 0, parent: null },
  }));
}

export type ServerStateFile = ReturnType<typeof serverStateFile>;
export type ClientLinkFile = ReturnType<typeof clientLinkFile>;

// Appends in-order events to a client's mirror. Returns the new last seq, or
// a gap when the batch does not continue the mirrored sequence.
export function ingestEvents(
  mirror: LinkedClient["mirror"],
  events: EventEnvelope[],
): { lastSeq: number; gap: boolean } {
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
