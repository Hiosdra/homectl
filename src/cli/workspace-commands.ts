// Owner commands for workspace mode (homelab #21 §6). Each one asks the local
// daemon, which holds the state and the link keys; this module never reads
// them. The owner password is passed on every call that changes trust,
// approves an operation or decrypts a backup, so the server sees a fresh
// step-up.
import { type CallOptions, callBroker } from "../broker/client";
import { HomectlError } from "../types";

type Emit = (value: unknown, human?: string) => void;

export interface OwnerAuth extends CallOptions {
  password: string;
}

// The broker call. Tests replace it; the daemon uses callBroker.
export type BrokerCall = <T>(
  path: string,
  body: Record<string, unknown>,
  auth: OwnerAuth,
) => Promise<T>;

export interface WorkspaceCommandOptions {
  auth(): Promise<OwnerAuth>;
  emit: Emit;
  remoteApproval: boolean;
  // --reason: required by restore-preview and restore.
  reason?: string;
  call?: BrokerCall;
}

interface RestoreResult {
  status: "none" | "restored" | "refused" | "failed";
  seq?: number;
  files?: string[];
  notes?: string[];
  acknowledged?: boolean;
  reason?: string;
}

const USAGE =
  "Usage: home-ctl workspace invite | join <address> <code> [--remote-approval] | status | clients | pending | intents [client] | decide <client> <operationId> <fingerprint> approve|deny | remove <client> | retired [client] | leave | sync-now | backup-now | request-backup <client> | restore-preview <client> [seq] --reason <text> | restore <client> <seq> --reason <text>";

function line(value: unknown): string {
  return JSON.stringify(value);
}

function when(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "never" : new Date(ms).toISOString();
}

function parseSeq(value: string | undefined, usage: string): number {
  const seq = Number(value);
  if (value === undefined || !Number.isSafeInteger(seq) || seq < 1)
    throw new HomectlError(2, usage);
  return seq;
}

function requireReason(reason: string | undefined, usage: string): string {
  if (!reason?.trim())
    throw new HomectlError(2, `${usage} --reason is required`);
  return reason.trim();
}

function describeJoin(
  result: {
    server: { name: string };
    sas: string;
    backupKey: string;
    restore?: RestoreResult;
  },
  remoteApproval: boolean,
): string {
  const lines = [
    `Linked to ${result.server.name}. Verification phrase: ${result.sas}. Remote approval: ${remoteApproval ? "on" : "off"}. Backup key registration with the server: ${result.backupKey}.`,
  ];
  const restore = result.restore ?? { status: "none" as const };
  if (restore.status === "restored") {
    lines.push(
      `Restored snapshot ${restore.seq}: ${(restore.files ?? []).join(", ")}. ${restore.acknowledged ? "The server confirmed the restore." : "The server has not confirmed the restore yet; this device retries on its next sync."} Check the inventory before using this device.`,
    );
    for (const note of restore.notes ?? []) lines.push(`  ${note}`);
  }
  if (restore.status === "refused" || restore.status === "failed")
    lines.push(`Restore not applied: ${restore.reason ?? restore.status}`);
  return lines.join("\n");
}

interface ClientRow {
  id: string;
  name: string;
  stale: boolean;
  remoteApproval: boolean;
  pending: number;
  backupRequested: boolean;
  backup: {
    latestSeq: number | null;
    latestAt: number | null;
    clientSeq: number | null;
    lagSnapshots: number | null;
    lagSeconds: number | null;
    clientLastError: string | null;
    snapshots: number;
    storedBytes: number;
    quota: { usedBytes: number; limitBytes: number };
    retention: { oldestAt: number | null; scheduled: boolean };
  };
}

function describeClient(c: ClientRow): string {
  const b = c.backup;
  const lines = [
    `${c.id}  ${c.name}${c.stale ? "  (stale)" : ""}  remote approval: ${c.remoteApproval ? "on" : "off"}  pending: ${c.pending}${c.backupRequested ? "  backup requested" : ""}`,
    `  backup: latest seq ${b.latestSeq ?? "none"} at ${when(b.latestAt)}; client at seq ${b.clientSeq ?? "unknown"}; lag ${b.lagSnapshots ?? "unknown"} snapshot(s), ${b.lagSeconds ?? "unknown"} s since last recoverable`,
    `  storage: ${b.storedBytes} bytes stored in ${b.snapshots} snapshot(s); quota ${b.quota.usedBytes} of ${b.quota.limitBytes} bytes`,
    `  retention: oldest snapshot ${when(b.retention.oldestAt)}; ${b.retention.scheduled ? "pruning scheduled" : "no automatic pruning yet, history is kept"}`,
  ];
  if (b.clientLastError)
    lines.push(`  last backup error: ${b.clientLastError}`);
  return lines.join("\n");
}

interface IntentView {
  id: string;
  decision: string;
  status: "queued" | "delivered" | "applied" | "refused";
  reason?: string;
  expiresAt: number;
}

interface PendingRow {
  origin: string;
  originName: string;
  id: string;
  host: string;
  argv: string[];
  fingerprint: string;
  risk: string;
  impact: string;
  intent: IntentView | null;
}

interface IntentRow extends IntentView {
  operationId: string;
  client: string;
}

function describeIntent(i: IntentView): string {
  return `${i.status} (${i.decision}${i.reason ? `: ${i.reason}` : ""})`;
}

function describePending(p: PendingRow): string {
  const decision = p.intent
    ? `  decision ${describeIntent(p.intent)}`
    : "  no decision queued";
  return `${p.id}  ${p.originName} -> ${p.host}  [${p.risk}]  fingerprint ${p.fingerprint}${decision}\n    ${p.impact}\n    ${JSON.stringify(p.argv)}`;
}

function describeIntentRow(i: IntentRow): string {
  return `${i.id}  ${i.client}  ${i.operationId}  ${describeIntent(i)}  expires ${when(i.expiresAt)}`;
}

interface RetiredRow {
  id: string;
  name: string;
  cause: string;
  retiredAt: number;
  restorable: boolean;
  historyKept: boolean;
  mirror: { lastSeq: number; gaps: number; events: number };
  pending: number;
}

function describeRetired(r: RetiredRow): string {
  return `${r.id}  ${r.name}  ${r.cause} at ${when(r.retiredAt)}  ${r.mirror.events} mirrored event(s), last seq ${r.mirror.lastSeq}, ${r.mirror.gaps} gap(s)  ${r.historyKept ? "history kept" : "history dropped"}  ${r.restorable ? "backups restorable" : "no backup key"}`;
}

// Returns an exit code. Positionals are the words after `workspace`.
export async function workspaceCommand(
  positionals: string[],
  options: WorkspaceCommandOptions,
): Promise<number> {
  const [action, ...rest] = positionals;
  const { emit } = options;
  if (!action) throw new HomectlError(2, USAGE);
  const auth = await options.auth();
  const call: BrokerCall = options.call ?? callBroker;
  const post = <T>(path: string, body: Record<string, unknown>) =>
    call<T>(path, body, auth);
  const password = auth.password;
  switch (action) {
    case "invite": {
      const result = await post<{
        code: string;
        expiresAt: string;
        server: { id: string; name: string };
      }>("/v1/owner/workspace/invite", { password });
      emit(
        result,
        `Enter code ${result.code} on the other device within 5 minutes (until ${result.expiresAt}). Compare the verification phrase it shows with the one from \`workspace join\`.`,
      );
      return 0;
    }
    case "join": {
      const [address, code] = rest;
      if (!address || !code)
        throw new HomectlError(
          2,
          "Usage: home-ctl workspace join <address> <code> [--remote-approval]",
        );
      const result = await post<{
        server: { id: string; name: string };
        sas: string;
        backupKey: string;
        restore?: RestoreResult;
      }>("/v1/owner/workspace/join", {
        address,
        code,
        remoteApproval: options.remoteApproval,
        password,
      });
      emit(result, describeJoin(result, options.remoteApproval));
      return 0;
    }
    case "status": {
      const result = await post("/v1/owner/workspace/status", {});
      emit(result, line(result));
      return 0;
    }
    case "clients": {
      const result = await post<ClientRow[]>("/v1/owner/workspace/clients", {});
      emit(
        result,
        result.length
          ? result.map(describeClient).join("\n")
          : "No linked clients.",
      );
      return 0;
    }
    case "pending": {
      const result = await post<PendingRow[]>(
        "/v1/owner/workspace/pending",
        {},
      );
      emit(
        result,
        result.length
          ? result.map(describePending).join("\n")
          : "Nothing is waiting for approval on linked clients.",
      );
      return 0;
    }
    case "intents": {
      const [client] = rest;
      const result = await post<{ intents: IntentRow[] }>(
        "/v1/owner/workspace/intents",
        client ? { client } : {},
      );
      emit(
        result,
        result.intents.length
          ? result.intents.map(describeIntentRow).join("\n")
          : "No decisions have been queued for linked clients.",
      );
      return 0;
    }
    case "decide": {
      const [client, operationId, fingerprint, verdict] = rest;
      const decision =
        verdict === "approve"
          ? "approve-once"
          : verdict === "deny"
            ? "deny-once"
            : undefined;
      if (!client || !operationId || !fingerprint || !decision)
        throw new HomectlError(
          2,
          "Usage: home-ctl workspace decide <client> <operationId> <fingerprint> approve|deny",
        );
      const result = await post<{ operationId: string; status: string }>(
        "/v1/owner/workspace/decide",
        { client, operationId, fingerprint, decision, password },
      );
      emit(
        result,
        `Queued ${verdict === "approve" ? "approval" : "denial"} for ${operationId} on ${client} (intent ${result.status}). The client applies it at its next sync.`,
      );
      return 0;
    }
    case "remove": {
      const [client] = rest;
      if (!client)
        throw new HomectlError(2, "Usage: home-ctl workspace remove <client>");
      const result = await post("/v1/owner/workspace/remove", {
        client,
        password,
      });
      emit(
        result,
        `Removed ${client}. It cannot rejoin with this identity. Its mirrored events are kept under \`workspace retired ${client}\`.`,
      );
      return 0;
    }
    case "retired": {
      const [client] = rest;
      const result = await post<RetiredRow[] | unknown>(
        "/v1/owner/workspace/retired",
        client ? { client } : {},
      );
      if (client) {
        emit(result, line(result));
        return 0;
      }
      const rows = result as RetiredRow[];
      emit(
        rows,
        rows.length
          ? rows.map(describeRetired).join("\n")
          : "No retired clients.",
      );
      return 0;
    }
    case "leave": {
      const result = await post("/v1/owner/workspace/leave", { password });
      emit(result, "Left the workspace server.");
      return 0;
    }
    case "sync-now": {
      const result = await post("/v1/owner/workspace/sync-now", {});
      emit(result, line(result));
      return 0;
    }
    case "backup-now": {
      const result = await post("/v1/owner/workspace/backup-now", {});
      emit(result, line(result));
      return 0;
    }
    case "request-backup": {
      const [client] = rest;
      if (!client)
        throw new HomectlError(
          2,
          "Usage: home-ctl workspace request-backup <client>",
        );
      const result = await post("/v1/owner/workspace/backup-request", {
        client,
      });
      emit(
        result,
        `Asked ${client} to back up at its next sync (within 5 seconds while it is online).`,
      );
      return 0;
    }
    case "restore-preview": {
      const usage =
        "Usage: home-ctl workspace restore-preview <client> [seq] --reason <text>";
      const [client, seqText] = rest;
      if (!client) throw new HomectlError(2, usage);
      const reason = requireReason(options.reason, usage);
      const seq = seqText === undefined ? undefined : parseSeq(seqText, usage);
      const result = await post<{
        source: string;
        seq: number;
        createdAt: number;
        bytes: number;
        verified: boolean;
        problems: string[];
        files: { path: string; size: number; restorable: boolean }[];
      }>("/v1/owner/workspace/restore-preview", {
        client,
        ...(seq === undefined ? {} : { seq }),
        reason,
        password,
      });
      const files = result.files.map(
        (f) =>
          `  ${f.path}  ${f.size} bytes  ${f.restorable ? "will be restored" : "not restored"}`,
      );
      emit(
        result,
        [
          `Snapshot ${result.seq} of ${client}, taken ${when(result.createdAt)}: ${result.verified ? "verified" : "NOT verified; a restore would be refused"}.`,
          ...result.problems.map((p) => `  problem: ${p}`),
          ...files,
        ].join("\n"),
      );
      return 0;
    }
    case "restore": {
      const usage =
        "Usage: home-ctl workspace restore <client> <seq> --reason <text>";
      const [client, seqText] = rest;
      if (!client || seqText === undefined) throw new HomectlError(2, usage);
      const reason = requireReason(options.reason, usage);
      const seq = parseSeq(seqText, usage);
      const result = await post<{
        code: string;
        expiresAt: string;
        restore: { source: string; seq: number; files: number; bytes: number };
      }>("/v1/owner/workspace/restore", {
        client,
        seq,
        reason,
        password,
      });
      emit(
        result,
        `Restoring snapshot ${seq} of ${client} (${result.restore.files} file(s), ${result.restore.bytes} bytes). ${client} is revoked. On the reset device run \`home-ctl workspace join <server> ${result.code}\` before ${result.expiresAt}. The restored files are written only to a device that has none of them yet, and the revocations reported by ${client} are reapplied to them.`,
      );
      return 0;
    }
    default:
      throw new HomectlError(2, USAGE);
  }
}
