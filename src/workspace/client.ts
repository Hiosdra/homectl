// Client side of workspace mode (homelab #21 §6). A linked client pushes its
// event tail and pending approvals to its server and applies the owner
// decisions the server queued for it, through its own engine and its own
// policy. It uploads scoped files as sealed chunks; the server never sees the
// backup key in clear.

import type { SnapshotInput } from "../backup";
import type { RouteExtension } from "../broker/server";
import type { BrokerOperation, DecideInput } from "../broker/types";
import type { EventEnvelope } from "../core/contracts";
import { isGap, type SinceResult } from "../events/log";
import { joinPair } from "../peer/pairing";
import { HomectlError } from "../types";
import {
  channelRequest,
  httpPost,
  type Post,
  workspaceAddress,
} from "./channel";
import { type BackupRun, runClientBackup } from "./client-backup";
import { type RestoreOutcome, takeRestore } from "./client-restore";
import {
  ClientDecisions,
  type DecisionAcceptance,
  type DecisionOutcome,
} from "./client-decisions";
import {
  ClientSecretDecisions,
  type WorkspaceClientSecretPort,
} from "./client-secrets";
import type { RestoreTarget } from "./restore-files";
import type { RevocationSet } from "./revocations";
import {
  type ClientLink,
  type ClientLinkFile,
  clientLinkFile,
  type Revocations,
} from "./state";
import {
  backupReport,
  errorText,
  peerOf,
  summarize,
  takeBatch,
} from "./summary";
import * as v from "./validate";

const MAX_CLIENT_PENDING = 200;

export interface WorkspaceClientDeps {
  pending(): Promise<BrokerOperation[]>;
  decide(input: DecideInput): Promise<DecisionAcceptance>;
  events: { since(after: number): Promise<SinceResult> };
  backupFiles(): Promise<SnapshotInput[]>;
  restore: RestoreTarget;
  secrets?: WorkspaceClientSecretPort;
  vaultUnlocked?: () => boolean;
  // The revocations this device holds now, reported with each sync.
  revocations?: () => Promise<RevocationSet | undefined>;
  // Transport per server address; tests route it in process.
  post?: (address: string) => Post;
  now?: () => number;
}

export type { BackupRun } from "./client-backup";

export class WorkspaceClient implements RouteExtension {
  private readonly file: ClientLinkFile;
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly post: (address: string) => Post;
  private readonly decisions: ClientDecisions;
  private readonly secretDecisions: ClientSecretDecisions | undefined;
  private outcomes: DecisionOutcome[] = [];
  private syncRun: Promise<void> | undefined;
  private backupRun: Promise<BackupRun | undefined> | undefined;
  private restoreRun: Promise<RestoreOutcome> | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    stateDir: string,
    private readonly deps: WorkspaceClientDeps,
  ) {
    this.file = clientLinkFile(stateDir);
    // Persists the link identity and backup key on first use.
    this.ready = this.file.update(() => undefined);
    this.now = deps.now ?? Date.now;
    this.post = deps.post ?? httpPost;
    this.decisions = new ClientDecisions(
      this.file,
      () => this.load(),
      deps.decide,
      this.now,
    );
    this.secretDecisions = deps.secrets
      ? new ClientSecretDecisions(
          this.file,
          () => this.load(),
          deps.secrets,
          this.now,
        )
      : undefined;
  }

  private async load(): Promise<ClientLink> {
    await this.ready;
    return this.file.read();
  }

  async owner(
    path: string,
    input: Record<string, unknown>,
    stepUp: (password: unknown) => Promise<void>,
  ): Promise<unknown> {
    switch (path) {
      case "/v1/owner/workspace/join":
        await stepUp(input.password);
        return this.join(input);
      case "/v1/owner/workspace/status":
        return this.status();
      case "/v1/owner/workspace/leave":
        await stepUp(input.password);
        return this.leave();
      case "/v1/owner/workspace/sync-now":
        return this.syncNow();
      case "/v1/owner/workspace/backup-now":
        return this.backupNow();
      default:
        return undefined;
    }
  }

  private async join(input: Record<string, unknown>) {
    const link = await this.load();
    if (link.server)
      throw new HomectlError(
        3,
        "This device is already linked to a server; leave it first",
      );
    const address = workspaceAddress(v.text(input.address, "address", 300));
    const code = v.text(input.code, "code", 9);
    const remoteApproval = v.flag(input.remoteApproval, "remote approval");
    const transport = this.post(address);
    // The pairing paths live under the workspace prefix on the server.
    const prefixed: Post = (path, value) =>
      transport(`/v1/workspace${path}`, value);
    const pair = await joinPair(
      address,
      code,
      { id: link.id, name: link.name, platform: process.platform },
      prefixed,
    );
    const key = pair.key;
    const remote = pair.remote;
    if (!key || !remote)
      throw new HomectlError(5, "Pairing returned no server identity");
    const keyHex = key.toString("hex");
    key.fill(0);
    await this.file.update((next) => {
      if (next.server)
        throw new HomectlError(
          3,
          "This device is already linked to a server; leave it first",
        );
      next.server = {
        id: remote.id,
        name: remote.name,
        address,
        key: keyHex,
        joinedAt: this.now(),
        remoteApproval,
      };
      next.eventsAcked = 0;
      next.backupKeyRegistered = false;
      next.lastSyncError = undefined;
    });
    this.outcomes = [];
    this.secretDecisions?.clearOutcomes();
    let backupKey: "registered" | "pending" = "registered";
    try {
      await this.registerBackupKey();
    } catch (error) {
      // Retried by the next backup run; the link itself is in place.
      backupKey = "pending";
      await this.noteError(error);
    }
    // Owed until the check settles: a device that could not reach the server
    // now retries on each sync while the grant lasts.
    await this.file.update((next) => {
      next.restorePending = true;
    });
    const restore = await this.restoreCheck();
    return {
      server: { id: remote.id, name: remote.name },
      sas: pair.sas,
      backupKey,
      restore,
    };
  }

  private async registerBackupKey(): Promise<void> {
    const link = await this.load();
    const server = link.server;
    if (!server) throw new HomectlError(3, "This device is not linked");
    await channelRequest(
      this.post(server.address),
      link.id,
      peerOf(server),
      "backup.key",
      { key: link.backup.key },
    );
    await this.file.update((next) => {
      if (next.server?.id === server.id) next.backupKeyRegistered = true;
    });
  }

  private async status() {
    const link = await this.load();
    const server = link.server;
    return {
      clientId: link.id,
      linked: server !== undefined,
      server: server
        ? { id: server.id, name: server.name, address: server.address }
        : null,
      remoteApproval: server?.remoteApproval === true,
      backupKeyRegistered: link.backupKeyRegistered === true,
      lastSyncAt: link.lastSyncAt ?? null,
      lastSyncError: link.lastSyncError ?? null,
      backup: {
        seq: link.backup.seq,
        lastAt: link.backup.lastAt ?? null,
        lastError: link.backup.lastError ?? null,
      },
    };
  }

  private async leave() {
    await this.file.update((next) => {
      if (!next.server)
        throw new HomectlError(3, "This device is not linked to a server");
      next.server = undefined;
      next.eventsAcked = 0;
      next.backupKeyRegistered = false;
      next.lastSyncAt = undefined;
      next.lastSyncError = undefined;
      next.restorePending = undefined;
      next.restore = undefined;
    });
    this.outcomes = [];
    this.secretDecisions?.clearOutcomes();
    return this.status();
  }

  // One restore check at a time. A device that was never reached (or whose
  // write failed) checks again on each sync until the server settles it.
  private restoreCheck(): Promise<RestoreOutcome> {
    this.restoreRun ??= this.runRestore().finally(() => {
      this.restoreRun = undefined;
    });
    return this.restoreRun;
  }

  private async runRestore(): Promise<RestoreOutcome> {
    const link = await this.load();
    const outcome = await takeRestore(
      this.post,
      link,
      this.deps.restore,
      (mutate) => this.file.update(mutate),
    );
    const settled =
      outcome.status === "none" ||
      outcome.status === "refused" ||
      (outcome.status === "restored" && outcome.acknowledged);
    await this.file.update((next) => {
      next.restorePending = settled ? undefined : true;
    });
    return outcome;
  }

  // What this device holds now, stamped with its own clock. Missing when the
  // report cannot be taken: the server then reapplies nothing.
  private async revocationReport(): Promise<Revocations | undefined> {
    if (!this.deps.revocations) return undefined;
    try {
      const report = await this.deps.revocations();
      return report ? { at: this.now(), ...report } : undefined;
    } catch {
      return undefined;
    }
  }

  private async syncNow() {
    const link = await this.load();
    if (!link.server)
      throw new HomectlError(3, "This device is not linked to a server");
    await this.syncOnce();
    return this.status();
  }

  private async backupNow() {
    const link = await this.load();
    if (!link.server)
      throw new HomectlError(3, "This device is not linked to a server");
    const run = await this.backupOnce();
    return { run: run ?? null, ...(await this.status()) };
  }

  // One sync at a time; a caller during a run gets the run in progress.
  syncOnce(): Promise<void> {
    this.syncRun ??= this.runSync().finally(() => {
      this.syncRun = undefined;
    });
    return this.syncRun;
  }

  private async runSync(): Promise<void> {
    const link = await this.load();
    if (!link.server) return;
    try {
      if (link.restorePending || link.restore)
        await this.restoreCheck().catch(() => undefined);
      // A second round sends the outcomes of decisions applied in the first.
      for (let round = 0; round < 2; round++)
        if (!(await this.exchange())) break;
    } catch (error) {
      await this.noteError(error);
      throw error;
    }
  }

  private async exchange(): Promise<boolean> {
    const link = await this.load();
    const server = link.server;
    if (!server) return false;
    const batch = await this.nextBatch(link.eventsAcked);
    const pending = (await this.deps.pending())
      .slice(0, MAX_CLIENT_PENDING)
      .map(summarize);
    const pendingSecrets = this.secretDecisions?.pendingSummaries(100);
    const sent = this.outcomes.slice();
    const sentSecrets = this.secretDecisions?.peekOutcomes() ?? [];
    const revocations = await this.revocationReport();
    const reply = v.parseReply(
      await channelRequest(
        this.post(server.address),
        link.id,
        peerOf(server),
        "sync",
        {
          after: batch.after,
          events: batch.events,
          pending,
          ...(pendingSecrets ? { pendingSecrets } : {}),
          intentResults: sent,
          ...(sentSecrets.length ? { secretIntentResults: sentSecrets } : {}),
          status: {
            remoteApproval: server.remoteApproval,
            vaultUnlocked: this.deps.vaultUnlocked?.() ?? false,
            backup: backupReport(link.backup),
            ...(revocations ? { revocations } : {}),
          },
        },
      ),
    );
    this.outcomes.splice(0, sent.length);
    this.secretDecisions?.ackOutcomes(sentSecrets.length);
    const now = this.now();
    await this.file.update((next) => {
      if (next.server?.id !== server.id) return;
      next.eventsAcked = reply.ack;
      next.lastSyncAt = now;
      next.lastSyncError = batch.note;
    });
    let applied = false;
    for (const intent of reply.intents) {
      const outcome = await this.decisions.apply(intent, server.id);
      if (!outcome) continue;
      this.outcomes.push(outcome);
      applied = true;
    }
    if (
      this.secretDecisions &&
      (await this.secretDecisions.applyAll(reply.secretIntents, server.id))
    )
      applied = true;
    // The owner asked for a backup now; it runs in the background.
    if (reply.backupRequested) this.backupOnce().catch(() => undefined);
    return applied;
  }

  // Events after the acknowledged position. A local gap (pruned before they
  // were mirrored) is sent as nothing and noted, never silently skipped.
  private async nextBatch(
    acked: number,
  ): Promise<{ after: number; events: EventEnvelope[]; note?: string }> {
    const since = await this.deps.events.since(acked);
    if (!isGap(since)) return { after: acked, events: takeBatch(since) };
    // Continue from the oldest retained event; the cursor jump tells the
    // server where its copy has a hole.
    const after = Math.max(0, since.firstRetainedSeq - 1);
    await this.file.update((next) => {
      next.eventsAcked = after;
    });
    const retained = await this.deps.events.since(after);
    return {
      after,
      events: isGap(retained) ? [] : takeBatch(retained),
      note: "Local events were pruned before they were mirrored; the server copy has a gap",
    };
  }

  // One backup run at a time. Errors are recorded and rethrown.
  backupOnce(): Promise<BackupRun | undefined> {
    this.backupRun ??= this.runBackup().finally(() => {
      this.backupRun = undefined;
    });
    return this.backupRun;
  }

  private async runBackup(): Promise<BackupRun | undefined> {
    return runClientBackup({
      link: await this.load(),
      file: this.file,
      post: this.post,
      backupFiles: () => this.deps.backupFiles(),
      registerBackupKey: () => this.registerBackupKey(),
      now: this.now,
    });
  }

  // Timers never throw: failures are recorded in the link state.
  start(intervalMs = 5_000, backupEveryMs = 900_000): void {
    this.stop();
    this.timers = [
      setInterval(() => {
        this.syncOnce().catch(() => undefined);
      }, intervalMs),
      setInterval(() => {
        this.backupOnce().catch(() => undefined);
      }, backupEveryMs),
    ];
    for (const timer of this.timers) timer.unref?.();
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private async noteError(error: unknown): Promise<void> {
    const message = errorText(error);
    await this.file.update((next) => {
      next.lastSyncError = message;
    });
  }
}
