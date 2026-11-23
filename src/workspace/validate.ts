// Shape and size checks for everything a workspace peer sends (homelab #21
// §6). Nothing that crosses the link is trusted for type, length or range
// before it is stored or acted on.
import {
  DECISION_SOURCES,
  type DecisionSource,
  type EventEnvelope,
  type EventType,
} from "../core/contracts";
import { MAX_EVENT_DATA_BYTES } from "../events/log";
import { HomectlError } from "../types";
import type { BackupReport, PendingSummary, Revocations } from "./state";
import {
  type PendingSecretSummary,
  parsePendingSecrets,
  parseServerSecretIntents,
  type ServerSecretIntent,
} from "./secret-intents";

export const MAX_SYNC_EVENTS = 500;
export const MAX_REVOKED_KEYS = 256;
export const MAX_POLICY_RULES = 2048;
const KEY_TYPE = /^[A-Za-z0-9@.+-]{1,64}$/;
export const MAX_PENDING = 200;
export const MAX_RESULTS = 200;
export const MAX_MISSING_IDS = 4096;
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_SEALED_CHARS = 1_500_000;
// A restore carries at most 8 MiB of plaintext, base64 encoded.
export const MAX_RESTORE_CHARS = Math.ceil((8 * 1024 * 1024) / 3) * 4;
const MAX_ARGV = 256;
const MAX_ARG = 4096;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface IntentResult {
  id: string;
  status: "applied" | "refused";
  reason?: string;
}

export interface ServerIntent {
  id: string;
  operationId: string;
  fingerprint: string;
  decision: "approve-once" | "deny-once";
  stepUp: boolean;
  expiresAt: number;
}

export interface SyncRequest {
  // The client's acknowledged cursor (see ingestEvents).
  after?: number;
  events: EventEnvelope[];
  pending: PendingSummary[];
  pendingSecrets?: PendingSecretSummary[];
  intentResults: IntentResult[];
  secretIntentResults?: IntentResult[];
  status: {
    remoteApproval: boolean;
    vaultUnlocked: boolean;
    backup?: BackupReport;
    revocations?: Revocations;
  };
}

export function fail(message: string): never {
  throw new HomectlError(2, message);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max)
    fail(`${label} is missing or longer than ${max} characters`);
  return value;
}

export function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be true or false`);
  return value;
}

export function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${label} must be a number`);
  return value;
}

export function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    fail(`${label} must be an integer of at least ${min}`);
  return value;
}

export function list<T>(
  value: unknown,
  label: string,
  max: number,
  item: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max)
    fail(`${label} must be a list of at most ${max} entries`);
  return value.map(item);
}

// Lowercase hex of a fixed length: 64 chars is 32 bytes (keys, chunk ids).
export function hex(value: unknown, label: string, chars = 64): string {
  if (
    typeof value !== "string" ||
    value.length !== chars ||
    !/^[0-9a-f]+$/.test(value)
  )
    fail(`${label} must be ${chars} lowercase hex characters`);
  return value;
}

// Decodes a base64 chunk blob with a size bound checked before decoding.
export function blob(value: unknown, label: string): Uint8Array {
  const maxChars = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars
  )
    fail(`${label} is missing or too large`);
  const encoded = value as string;
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0)
    fail(`${label} must be base64`);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES)
    fail(`${label} is empty or larger than 2 MiB`);
  return new Uint8Array(bytes);
}

export function parseEvents(value: unknown): EventEnvelope[] {
  return list(value, "events", MAX_SYNC_EVENTS, (item) => {
    const event = record(item, "event");
    const seq = integer(event.seq, "event seq", 1);
    if (JSON.stringify(event.data ?? null).length > MAX_EVENT_DATA_BYTES)
      fail("event data is too large");
    return {
      id: text(event.id, "event id", 128),
      origin: text(event.origin, "event origin", 128),
      seq,
      at: finite(event.at, "event time"),
      type: text(event.type, "event type", 64) as EventType,
      subject: text(event.subject, "event subject", 256),
      audience: list(event.audience, "event audience", 64, (entry) =>
        text(entry, "audience", 128),
      ),
      data: event.data,
    };
  });
}

function decisionSource(value: unknown): DecisionSource | undefined {
  return (DECISION_SOURCES as readonly unknown[]).includes(value)
    ? (value as DecisionSource)
    : undefined;
}

export function parsePending(value: unknown): PendingSummary[] {
  return list(value, "pending", MAX_PENDING, (item) => {
    const pending = record(item, "pending operation");
    const summary: PendingSummary = {
      id: text(pending.id, "operation id", 128),
      client: text(pending.client, "client", 128),
      host: text(pending.host, "host", 255),
      argv: list(pending.argv, "argv", MAX_ARGV, (entry) =>
        text(entry, "argument", MAX_ARG),
      ),
      risk: text(pending.risk, "risk", 64),
      impact: text(pending.impact, "impact", 256),
      fingerprint: text(pending.fingerprint, "fingerprint", 256),
      reason: text(pending.reason, "reason", 512),
      stepUp: flag(pending.stepUp, "stepUp"),
      humanOnly: flag(pending.humanOnly, "humanOnly"),
      expiresAt: finite(pending.expiresAt, "expiry"),
    };
    // Optional and display-only: an unknown source is dropped, never a reason to
    // refuse the whole sync, so one unfamiliar value cannot hide every approval.
    const source = decisionSource(pending.source);
    if (source !== undefined) summary.source = source;
    if (pending.narrative !== undefined)
      summary.narrative = {
        untrusted: text(
          record(pending.narrative, "narrative").untrusted,
          "narrative",
          4096,
        ),
      };
    return summary;
  });
}

export function parseResults(value: unknown): IntentResult[] {
  return list(value, "intent results", MAX_RESULTS, (item) => {
    const result = record(item, "intent result");
    const status = result.status;
    if (status !== "applied" && status !== "refused")
      fail("intent result status is invalid");
    const parsed: IntentResult = {
      id: text(result.id, "intent id", 64),
      status: status as IntentResult["status"],
    };
    if (result.reason !== undefined)
      parsed.reason = text(result.reason, "reason", 300);
    return parsed;
  });
}

export function parseStatus(value: unknown): SyncRequest["status"] {
  const status = record(value, "status");
  return {
    remoteApproval: flag(status.remoteApproval, "remoteApproval"),
    vaultUnlocked: flag(status.vaultUnlocked, "vaultUnlocked"),
    ...(status.backup === undefined
      ? {}
      : { backup: parseBackupReport(status.backup) }),
    ...(status.revocations === undefined
      ? {}
      : { revocations: parseRevocations(status.revocations) }),
  };
}

// A client's revocations: @revoked host keys and, when it could read its
// policy, the ids of the rules it holds.
export function parseRevocations(value: unknown): Revocations {
  const report = record(value, "revocations");
  return {
    at: finite(report.at, "revocation time"),
    hostKeys: list(
      report.hostKeys,
      "revoked host keys",
      MAX_REVOKED_KEYS,
      (item) => {
        const key = record(item, "revoked host key");
        const type = text(key.type, "key type", 64);
        const blob = text(key.blob, "key blob", 16384);
        if (!KEY_TYPE.test(type) || !BASE64.test(blob) || blob.length === 0)
          fail("revoked host key is malformed");
        return { type, blob };
      },
    ),
    ...(report.policyRules === undefined
      ? {}
      : {
          policyRules: list(
            report.policyRules,
            "policy rules",
            MAX_POLICY_RULES,
            (item) => text(item, "rule id", 128),
          ),
        }),
  };
}

export function parseBackupReport(value: unknown): BackupReport {
  const report = record(value, "backup report");
  return {
    seq: integer(report.seq, "backup seq"),
    ...(report.lastAt === undefined
      ? {}
      : { lastAt: finite(report.lastAt, "last backup time") }),
    ...(report.lastError === undefined
      ? {}
      : { lastError: text(report.lastError, "last backup error", 300) }),
  };
}

// Restore messages (homelab #21 §6, W5). The files are base64 under the
// channel seal; each path is checked again by the client before it is written.
export interface RestoreFileWire {
  path: string;
  data: string;
}

export function parseRestoreStatus(value: unknown): {
  pending: boolean;
  seq?: number;
  expiresAt?: number;
} {
  const reply = record(value, "restore status");
  const pending = flag(reply.pending, "pending");
  if (!pending) return { pending };
  return {
    pending,
    seq: integer(reply.seq, "restore seq", 1),
    expiresAt: finite(reply.expiresAt, "restore expiry"),
  };
}

export function parseRestoreDelivery(value: unknown): {
  status: "none" | "restored";
  seq?: number;
  files?: RestoreFileWire[];
  notes: string[];
} {
  const reply = record(value, "restore delivery");
  if (reply.status === "none") return { status: "none", notes: [] };
  if (reply.status !== "restored") fail("restore delivery status is invalid");
  return {
    status: "restored",
    seq: integer(reply.seq, "restore seq", 1),
    files: list(reply.files, "restore files", 16, (item) => {
      const file = record(item, "restore file");
      return {
        path: text(file.path, "restore path", 128),
        data: text(file.data, "restore data", MAX_RESTORE_CHARS),
      };
    }),
    notes: list(reply.notes, "restore notes", 16, (item) =>
      text(item, "restore note", 300),
    ),
  };
}

export function parseRestoreAck(value: unknown): void {
  if (flag(record(value, "restore ack").acknowledged, "acknowledged") !== true)
    fail("restore was not acknowledged");
}

export function parseRestoreDecline(value: unknown): void {
  if (flag(record(value, "restore decline").declined, "declined") !== true)
    fail("restore was not declined");
}

export function parseSync(value: unknown): SyncRequest {
  const body = record(value, "sync");
  return {
    ...(body.after === undefined
      ? {}
      : { after: integer(body.after, "after") }),
    events: parseEvents(body.events),
    pending: parsePending(body.pending),
    ...(body.pendingSecrets === undefined
      ? {}
      : { pendingSecrets: parsePendingSecrets(body.pendingSecrets) }),
    intentResults: parseResults(body.intentResults),
    ...(body.secretIntentResults === undefined
      ? {}
      : { secretIntentResults: parseResults(body.secretIntentResults) }),
    status: parseStatus(body.status),
  };
}

// The server's answer to a sync: its mirror position and queued decisions.
export function parseReply(value: unknown): {
  ack: number;
  gap: boolean;
  intents: ServerIntent[];
  secretIntents: ServerSecretIntent[];
  backupRequested: boolean;
} {
  const reply = record(value, "sync reply");
  return {
    ack: integer(reply.ack, "ack"),
    gap: flag(reply.gap, "gap"),
    backupRequested: reply.backupRequested === true,
    intents:
      reply.intents === undefined
        ? []
        : list(reply.intents, "intents", MAX_RESULTS, (item) => {
            const intent = record(item, "intent");
            const decision = intent.decision;
            if (decision !== "approve-once" && decision !== "deny-once")
              fail("intent decision is invalid");
            return {
              id: text(intent.id, "intent id", 64),
              operationId: text(intent.operationId, "operation id", 128),
              fingerprint: text(intent.fingerprint, "fingerprint", 256),
              decision: decision as ServerIntent["decision"],
              stepUp: flag(intent.stepUp, "stepUp"),
              expiresAt: finite(intent.expiresAt, "expiry"),
            };
          }),
    secretIntents: parseServerSecretIntents(reply.secretIntents),
  };
}

export function parseCommit(value: unknown) {
  const commit = record(value, "commit result");
  const status = commit.status;
  if (status === "committed" || status === "unchanged")
    return { status, seq: integer(commit.seq, "seq", 1) } as const;
  if (status === "gap")
    return {
      status,
      latestSeq: integer(commit.latestSeq, "latestSeq"),
      latestHash:
        commit.latestHash === null
          ? null
          : hex(commit.latestHash, "latestHash"),
    } as const;
  return fail("commit result status is invalid");
}
