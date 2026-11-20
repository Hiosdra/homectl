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

## Roles and trust

**Server.** Keeps:

- its identity and a **custody key** that wraps each client's backup key (see [backup custody](security.md#backup-custody));
- one record per linked client: name, platform, link key, last-seen time, whether the client accepts remote approval, whether its vault is unlocked, a mirror of its most recent events (up to 500), its pending approvals and the decisions queued for it;
- a list of removed clients, so a stale link cannot bring one back.

The server never runs commands itself. It queues decisions. Each client applies a decision only through its own engine and its own approval policy.

**Client.** Keeps:

- the link to its one server: server identity, address, link key, and the time it joined;
- the newest server events it has acknowledged, and the last 512 decisions it has applied or refused, so a replayed decision is ignored;
- its own backup key, sequence number and parent snapshot.

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

| Command                                                               | What it does                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace invite`                                                    | On a server: create a pairing code, valid 5 minutes.                                                                                                                                                               |
| `workspace join <address> <code> [--remote-approval]`                 | On a client: link to the server and show the verification phrase.                                                                                                                                                  |
| `workspace status`                                                    | Show this broker's workspace state as JSON.                                                                                                                                                                        |
| `workspace clients`                                                   | List linked clients, with `(stale)` for any not seen in the last 60 seconds, remote-approval on or off, and the number of pending operations.                                                                      |
| `workspace pending`                                                   | List operations that linked clients are waiting on.                                                                                                                                                                |
| `workspace decide <client> <operationId> <fingerprint> approve\|deny` | On a server: queue a one-time approve or deny for one client's operation. The fingerprint must match the one from `pending`. The client must have joined with `--remote-approval`; step-up operations are refused. |
| `workspace remove <client>`                                           | On a server: unlink a client. It is remembered as removed.                                                                                                                                                         |
| `workspace leave`                                                     | On a client: unlink from the server.                                                                                                                                                                               |
| `workspace sync-now`                                                  | Run a sync with the server now and wait for it.                                                                                                                                                                    |
| `workspace backup-now`                                                | Run a backup now and wait for it; prints the new sequence number and how many chunks were uploaded or reused.                                                                                                      |

A linked client also syncs every 5 seconds and backs up every 15 minutes on its own.

Workspace decisions are one-time only: `approve-once` and `deny-once`. Remembering a rule (`--remember`) is local to each client's own policy and is not sent through the workspace.

## Mirrored approvals and events

**Approvals.** A client publishes a summary of each operation waiting for its owner. The summary includes the operation id, client, host, argv, risk, fingerprint, reason, whether step-up is required, whether the action is human-only, and when it expires. The requester's narrative is marked **untrusted** and shown as text, never as instructions.

A decision you make on the server goes through these states: `queued`, then `delivered` to the client, then `applied` or `refused`. The client applies it only if the fingerprint still matches and its own policy agrees. A decision that is not finished within 120 seconds expires. Expired decisions do not apply, and you decide again.

The server refuses to queue a decision for a client that has not opted in to remote approval, and the client refuses one again if it arrives anyway. A decision is applied at most once: the client records each decision id before acting on it.

**Events.** A client pushes its most recent events to the server in sequence. The server stores them in order and skips duplicates. If the client's own log was pruned before events were mirrored, the client says so, the server counts the gap (shown as `mirror.gaps` in `workspace clients`), and mirroring continues from the oldest retained event. The event types are:

`approval.requested`, `approval.decided`, `operation.updated`, `task.updated`, `secret.requested`, `secret.resolved`, `backup.updated`, `settings.updated`, `device.updated`, `vault.locked`, `vault.unlocked`.

The server keeps the most recent 500 events per client.

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

**Retention.** `prune` keeps the newest verified snapshot and everything newer than it, so a known-good restore point survives. Unreferenced chunks are removed by a mark-and-sweep across all clients. A chunk that is younger than one day is never removed, so an upload still waiting for its commit is safe.

**Storage.** Chunks are stored under `chunks/<first two hex characters>/<chunk ID>`, and manifests under `manifests/<client>/<sequence, 10 digits>.json.enc`. All directories are private to the broker's user, and every write goes to a temporary file that is renamed into place.

**Status.** The panel reads only manifest headers, so it can show backup status without any key.

The client backs up `inventory.yaml`, `known_hosts` and the policy file. Tests cover upload, chunk reuse, a refused foreign client id, and that no plaintext reaches the server's store.

## Restore

A restore needs an owner authorization: it is a human-only action, the owner must enter the password again (step-up), and a reason must be given. Restore refuses to return data unless the whole snapshot verifies: every chunk is decrypted, its ID and each file's size and SHA-256 are checked, and the cleartext header must match the sealed manifest.

<!-- verify: there is no restore command yet. Document the command once it exists in src/cli/workspace-commands.ts, and test a full restore on a second machine before relying on it. -->
