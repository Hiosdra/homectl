# Workspace (optional server mode)

A **workspace** is an optional way to connect several homectl brokers. One broker acts as the **server**, and other brokers join it as **clients**. The server shows what each client is doing, queues your approval decisions for clients to apply, and keeps their encrypted backups. The server holds the custody key for those backups, so it **can** decrypt them when you authorise a restore (see [backup custody](security.md#backup-custody)).

Clients work without a server. Nothing you do locally depends on the link being up.

Behaviour below is covered by in-process tests (`tests/workspace-*.test.ts`). A live run between two machines is part of the release gate and is not claimed here.

## Contents

- [Roles and trust](#roles-and-trust)
- [Pair a client](#pair-a-client)
- [Commands](#commands)
- [Mirrored approvals and events](#mirrored-approvals-and-events)
- [Offline behaviour](#offline-behaviour)
- [Incremental encrypted backups](#incremental-encrypted-backups)
- [Restore](#restore)
- [Lost server](#lost-server)

## Roles and trust

**Server.** Keeps:

- its identity and a **custody key** that wraps each client's backup key (see [backup custody](security.md#backup-custody));
- one record per linked client: name, platform, link key, last-seen time, whether the client accepts remote approval, whether its vault is unlocked, a mirror of its most recent events (up to 500), its pending approvals, the decisions queued for it, and the revocations it last reported;
- a list of removed clients, so a stale link cannot bring one back;
- a record of each retired client: its last mirror as read-only history, and its wrapped backup key (see **Retired clients** under [Mirrored approvals and events](#mirrored-approvals-and-events)).

The server never runs commands itself. It queues decisions. Each client applies a decision only through its own engine and its own approval policy.

**Client.** Keeps:

- the link to its one server: server identity, address, link key, and the time it joined;
- the newest server events it has acknowledged, and the last 512 decisions it has applied or refused, so a replayed decision is ignored;
- its own backup key, sequence number and parent snapshot;
- while a restore is being taken: the restore it wrote but the server has not yet acknowledged, and whether a restore check is still owed.

Both sides keep these files in the broker's private state directory, written atomically with owner-only permissions. They hold link keys, so do not copy them into repositories or chat.

## Pair a client

Turn a broker into the server by starting it with a listener for clients:

```sh
HOMECTL_WORKSPACE_LISTEN=0.0.0.0:7450 home-ctl daemon run
```

That listener serves only the pairing and sync endpoints, and every message after pairing is sealed. Without the variable a broker is a client only. Pairing uses a one-time code. Start on the server:

```sh
home-ctl workspace invite
```

It prints a code that is valid for **5 minutes** and good for one attempt; a wrong code closes the invite. Then, on the client:

```sh
home-ctl workspace join <server-address> <code> [--remote-approval]
```

The code itself authenticates both sides (SRP), so a device that does not know it cannot pair or impersonate the server. `join` also prints a **verification phrase** you can compare with the server for extra assurance. A code that expires needs a new `invite`.

`--remote-approval` lets the server's owner approve or deny this client's ordinary operations. Without it the client refuses every server decision and reports why. To change it, `workspace leave` and join again. Operations that need **step-up** are never approved remotely: approve them on the client itself.

During `join` the client sends its backup key to the server, which stores it wrapped under its custody key. The output shows only whether that registration succeeded, never the key.

Channel protection: every request from a client to the server is two round trips. The server first answers a challenge with an HMAC proof under the link key, which shows the client that it is talking to its server. The client then sends one request sealed under a key derived from a fresh X25519 exchange and the link key. Each challenge is used once and expires after 30 seconds, so a captured request cannot be replayed. The context string `workspace-v1` keeps workspace keys apart from the 0.2 peer protocol.

## Commands

Run these on the broker's machine. Each one asks the local broker, which holds the state and the keys; the CLI never reads them directly.

| Command                                                               | What it does                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace invite`                                                    | On a server: create a pairing code, valid 5 minutes.                                                                                                                                                                                                                                                   |
| `workspace join <address> <code> [--remote-approval]`                 | On a client: link to the server and show the verification phrase. If a restore waits for this device, it is taken here too (see [Restore](#restore)).                                                                                                                                                  |
| `workspace status`                                                    | Show this broker's workspace state as JSON.                                                                                                                                                                                                                                                            |
| `workspace clients`                                                   | List linked clients, with `(stale)` for any not seen in the last 60 seconds, remote-approval on or off, pending operations, and backup health: latest seq, lag, stored size, quota use and retention (see the status paragraph under [incremental encrypted backups](#incremental-encrypted-backups)). |
| `workspace pending`                                                   | List operations that linked clients are waiting on, with a one-line `impact` for each and the status of the decision queued for it (see [Approvals](#mirrored-approvals-and-events)).                                                                                                                  |
| `workspace intents [client]`                                          | On a server: list the decisions queued for linked clients (or one client), newest first, with their status (`queued`, `delivered`, `applied`, `refused`) and any refusal reason.                                                                                                                       |
| `workspace decide <client> <operationId> <fingerprint> approve\|deny` | On a server: queue a one-time approve or deny for one client's operation. The fingerprint must match the one from `pending`. The client must have joined with `--remote-approval`; step-up operations are refused.                                                                                     |
| `workspace remove <client>`                                           | On a server: unlink a client. It is remembered as removed, and its last mirror is kept under `retired`.                                                                                                                                                                                                |
| `workspace retired [client]`                                          | On a server: list the retired clients, why each left, and whether its backups are still restorable. With a client id, also its mirrored events and pending summaries. Read-only.                                                                                                                       |
| `workspace leave`                                                     | On a client: unlink from the server.                                                                                                                                                                                                                                                                   |
| `workspace sync-now`                                                  | Run a sync with the server now and wait for it.                                                                                                                                                                                                                                                        |
| `workspace backup-now`                                                | Run a backup now and wait for it; prints the new sequence number and how many chunks were uploaded or reused.                                                                                                                                                                                          |
| `workspace request-backup <client>`                                   | On a server: ask a client to back up on its next sync. The request is delivered once.                                                                                                                                                                                                                  |
| `workspace restore-preview <client> [seq] --reason <text>`            | On a server: list the files, sizes and sequence of a client's snapshot, and whether it verifies. Needs step-up and a reason. Nothing changes. See [Restore](#restore).                                                                                                                                 |
| `workspace restore <client> <seq> --reason <text>`                    | On a server: restore a reset client's state. Needs step-up and a reason. Retires the client, reapplies the revocations it last reported, and issues a pairing code for a fresh device. See [Restore](#restore).                                                                                        |

A linked client also syncs every 5 seconds and backs up every 15 minutes on its own.

Workspace decisions are one-time only: `approve-once` and `deny-once`. Remembering a rule (`--remember`) is local to each client's own policy and is not sent through the workspace.

## Mirrored approvals and events

**Approvals.** A client publishes a summary of each operation waiting for its owner. The summary includes the operation id, client, host, argv, risk, fingerprint, reason, decision source, whether step-up is required, whether the action is human-only, and when it expires. Its `impact` is one line built from the operation's own fields: whether it reads, changes or destructively changes state, the host, the command, and whether it runs with sudo. The requester's narrative is marked **untrusted** and shown as text, never as instructions, and it never feeds the impact line.

A decision you make on the server goes through these states: `queued`, then `delivered` to the client, then `applied` or `refused`. The client applies it only if the fingerprint still matches and its own policy agrees. A decision that is not finished within 120 seconds expires. Expired decisions do not apply, and you decide again.

`workspace intents [client]` lists the decisions queued for linked clients, newest first and bounded (50 by default, 200 at most), each with its status and, when refused, its reason. `workspace pending` shows the newest decision for each operation beside it, so you can see whether one is still on its way.

**Device context.** On a server, the owner panel's one **Devices** switcher (on the Needs you and Workspace screens) picks what those views show: All devices, This device (local approvals and secret requests only), or one linked client. The choice is a view filter only, remembered in this browser's local storage and never in the URL; every decision still goes to the same client and operation id. Without a workspace server there is no switcher.

Each summary also carries the decision `source` on the client. While the Auto Mode reviewer is still deciding, it is `review`: the operation waits for you, and approve-and-remember is refused until the review ends.

The server refuses to queue a decision for a client that has not opted in to remote approval, and the client refuses one again if it arrives anyway. A decision is applied at most once: the client records each decision id before acting on it.

**Live updates.** While a client is connected, its new approvals and finished decisions reach the server's owner streams as they happen, not on the next poll:

- `approval.requested`: a sync brings a new pending approval that has not expired.
- `approval.decided`: a queued decision reaches `applied` or `refused`, including one that expired on the server.

Both events carry a canonical id, `<client id>:<operation id>`, so a panel that receives an item by push and again by poll shows it once. The data holds the ids, the client's id and name, the host, the risk and, for a decided item, the decision, its status and any reason. It holds no argv, narrative or fingerprint. Read those from `workspace pending`, which only the owner can call. Both events have an empty audience: owner streams receive them, and no linked client does, so one client never sees another client's items.

A decision made on the client itself is not pushed; it shows on the server at the client's next sync (within 5 seconds). The events are written after the server saves the sync, and a failed write does not lose the item: it still appears in the next poll. The daemon always gives the server an event port, so a running server pushes; a server built without one, as in some tests, pushes nothing and owner surfaces rely on polling alone.

**Events.** A client pushes its most recent events to the server in sequence. The server stores them in order and skips duplicates. If the client's own log was pruned before events were mirrored, the client says so, the server counts the gap (shown as `mirror.gaps` in `workspace clients`), and mirroring continues from the oldest retained event. The event types are:

`approval.requested`, `approval.decided`, `operation.updated`, `task.updated`, `secret.requested`, `secret.resolved`, `backup.updated`, `settings.updated`, `device.updated`, `vault.locked`, `vault.unlocked`.

The server keeps the most recent 500 events per linked client.

**Retired clients.** When a client leaves the server, its last mirror is kept as read-only history rather than dropped: its events (up to the newest 100) and its pending summaries (up to 50). The history is bounded: only the 20 most recently retired clients keep it. Older retired clients keep their identity and wrapped backup key, so their backups stay restorable, but no events. A client leaves in one of three ways, shown as its `cause`:

- `removed`: the owner ran `workspace remove`;
- `restore`: the client was reset and its state restored onto a fresh device;
- `declined`: a fresh device that already held restorable files declined a restore, so its own identity was discarded.

A retired client's id stays in `removed`. It cannot pair or sync again, and nothing can be queued for it. `workspace retired` only reads this history.

## Offline behaviour

- **A client keeps working alone.** Its own broker, vault, policy and approvals do not wait for the server. Without a link, the workspace client loop does not start.
- **The server marks an unreachable client as stale** when it has not been seen for 60 seconds. Its mirrored data is then labelled stale in `workspace clients`.
- **Decisions expire.** A decision queued for an offline client expires after 120 seconds. Queue it again when the client is back.

## Incremental encrypted backups

Each client backs up its own scoped state, in encrypted, incremental snapshots.

**What is backed up.** Only intentionally scoped persistent state. Live sessions (`*.session`), sockets (`*.sock`), lock files (`*.lock`), ephemeral secrets, pending approvals, and the device and owner key and endpoint files are refused with an error, not silently skipped. Nobody can believe they were captured.

**How it is sealed.**

- Files are split into fixed **1 MiB** chunks.
- Each chunk is encrypted with AES-256-GCM under a random 12-byte IV. Keys come from HKDF-SHA256.
- A chunk's ID is a keyed HMAC-SHA256 of its plaintext, so identical content is stored once.
- Each blob's authenticated data binds it to its chunk ID, manifest sequence number and client ID. A blob cannot be moved to another slot and still open.

**How it is uploaded.** The client asks the server which chunks it lacks, uploads only those, and then commits a sealed manifest. An interrupted upload resumes where it stopped. If the server's history does not connect to the client's (a gap), the client starts a new full baseline and the server keeps the old history.

**What the server checks.** On commit, the server checks the chain (sequence number and parent), that every chunk the manifest refers to exists, and that each blob is well formed. It never decrypts a backup during a commit. The server does hold the wrapped client keys (custody), so it **can** decrypt a backup when you authorise a restore. See [security](security.md#backup-custody).

**Retention.** `prune` keeps the newest verified snapshot and everything newer than it, so a known-good restore point survives. Unreferenced chunks are removed by a mark-and-sweep across all clients. A chunk that is younger than one day is never removed, so an upload still waiting for its commit is safe. The workspace server does not run `prune` on a schedule yet, so history is kept until it is pruned; `workspace clients` says so.

**Quota.** Each client may hold at most a set number of sealed chunk bytes on the server. The default is **1 GiB**. A server with a listener sets another limit with `HOMECTL_WORKSPACE_QUOTA_MB` (whole MiB, 1 to 1048576). An upload that would go over the limit is refused with `Backup storage quota reached` and the client records it as its last backup error. A chunk the client already holds is never charged twice. The server counts chunks referenced by the client's retained snapshots plus chunks uploaded since the count was last built. The count is built at startup from the manifests, so an upload that never committed before a restart is not counted again. Any removal from the store (a prune, or the sweep that follows it) rebuilds the count in the same way, so a pruned client is not overcounted until the next restart. An upload still waiting for its commit during a prune is not counted until the next rebuild, so the count can briefly read low.

**Storage.** Chunks are stored under `chunks/<first two hex characters>/<chunk ID>`, and manifests under `manifests/<client>/<sequence, 10 digits>.json.enc`. All directories are private to the broker's user, and every write goes to a temporary file that is renamed into place.

**Status.** The panel reads only manifest headers, so it can show backup status without any key. `workspace clients` shows, for each client, the latest sequence the server holds and when it was made, the client's reported sequence and the **lag** (snapshots the client has that the server does not, and seconds since the last recoverable snapshot), the stored size, quota use, the number of retained snapshots and the oldest one. A client's last backup error is shown there too. `workspace status` on a client shows its own last backup sequence, time and error. The server can ask a client to back up now with `workspace request-backup`.

The client backs up `inventory.yaml`, `known_hosts` and the policy file. Tests cover upload, chunk reuse, a refused foreign client id, and that no plaintext reaches the server's store.

## Restore

A restore brings a **reset** client's scoped state back onto a fresh device. A retry verifies the installed files against the snapshot before confirming recovery. If any installed file is missing or has changed, the client keeps the files for your review and leaves the restore unconfirmed. It runs on the server, is owner-only, and is never automatic. Files are written only to a device that holds none of them yet.

**Steps.**

1. **Preview.** `home-ctl workspace restore-preview <client> [seq] --reason "<why>"`, then enter the owner password. It lists each file in the snapshot with its size, whether it would be restored, and whether the snapshot verifies. Without `seq` it previews the latest snapshot.
2. **Restore.** `home-ctl workspace restore <client> <seq> --reason "<why>"`, then enter the owner password. The server verifies the whole snapshot again. Only if it verifies:
   - the client is **retired** (`cause: restore`): its link and queued work go, its id is listed under `removed`, and its mirror is kept as history;
   - its wrapped backup key stays in the retired record, so its history stays restorable for later previews and restores;
   - the revocations it last reported are kept with the restore (see **Revocations** below);
   - a pairing code is printed, valid for 5 minutes.
3. **Join the fresh device.** Run `home-ctl workspace join <server> <code>` on the reset device and enter that device's owner password. The device gets a new client id and a new backup key. The restore waits for this device for 10 minutes after it pairs. Then the device does one of two things:
   - **It holds no restorable files beyond the empty inventory that setup creates:** it fetches them, writes them, and acknowledges the write. The server ends the restore only on that acknowledgment.
   - **It holds a configured inventory or another restorable file:** it declines. The server retires the fresh identity, and the device unlinks itself and gets a new identity, so nothing stale remains. The join output says what to do: move the files aside, have the owner issue the restore again, and join with the new code.

**What is restored.** Only `inventory.yaml`, `known_hosts` and `policy.json`, the same files a client backs up. Anything else in a snapshot is listed by the preview and not delivered. Live sessions, pending approvals, ephemeral secrets and device or owner key material are never restored, so the reset client starts with none of them.

**Revocations.** At each sync a client reports the host keys its `known_hosts` lists as `@revoked`, and the ids of the rules in its policy (omitted when the policy cannot be read). The restore reapplies the last report for the source client:

- a pinned `known_hosts` line for a revoked key is removed, and an `@revoked` line is written for that key;
- a policy rule that the snapshot has but the report does not is removed. This happens only when the report is at or after the snapshot, because an older report cannot tell a rule removed later from one added after it. Otherwise the policy is not filtered, and the join output says so.

The join output lists what was changed, and always says that revocations made after the client's last report are not known. The inventory is never changed. Revocations made after that last report must be checked by the owner.

**Delivery and acknowledgment.**

- A fetch does not end the restore. If the reply is lost, the same identity fetches the same files again, until the 10-minute window closes.
- A failed write is undone, so the next attempt starts from a device with none of the files.
- A device that wrote the files but lost its acknowledgment acknowledges again, without fetching or writing again.
- Only the identity holding the restore can fetch or acknowledge it. The revoked source cannot.
- Once the window closes unused, nothing is delivered. Issue a new restore.

**Safeguards.**

- Preview and restore each need the owner password (step-up) and a reason.
- A snapshot that fails verification is refused before anything is retired. The source stays linked.
- Every decryption, the retirement, the issue, each delivery, each acknowledgment and each decline is written to `workspace-audit.jsonl` in the server's state directory. It is a SHA-256 hash chain of JSON lines with identifiers, reasons and outcomes, and never backup contents.
- Effects of operations that ran before the reset are not reconciled automatically. The owner must check them.

**Verification.** The restore protocol is covered by in-process tests in `tests/workspace-restore.test.ts`, `tests/workspace-revocations.test.ts`, `tests/workspace-retired.test.ts` and `tests/workspace-cli.test.ts`. The `--reason` option reaches the workspace commands through the CLI parser (`src/cli/broker-commands.ts`). A loopback integration test runs three actual brokers against separate disposable workspaces and checks a backup, a reset-client restore and retirement of the old client. A full restore between two physical machines still belongs to the release gate.

## Lost server

If the server is lost, the clients keep working. Each client runs its own broker, vault, policy and approvals and does not wait for the server (see [offline behaviour](#offline-behaviour)). What stops is the shared part: approvals from linked clients, the mirrored status, and new backups.

Backups are held only on the server, so a restore needs two things from it:

- the **custody key**, in `workspace-server.json` in the broker's state directory. It wraps each client's backup key (see [backup custody](security.md#backup-custody));
- the **backup store**, the sealed chunks and manifests in `workspace-backups` in the same directory.

Without both, the held backups cannot be opened. Keep independent copies of both, off the server. Backing them up belongs to the backup and disaster-recovery work in homelab #3.

Single-server history is not disaster recovery. The server's mirror and `workspace-audit.jsonl` record what happened; they do not hold the backup data or the custody key, so they cannot restore a client.

This release has no command that rebuilds a lost server from those copies, and no procedure for linking clients to a replacement server. No test covers either. Treat that recovery as manual and unverified.
