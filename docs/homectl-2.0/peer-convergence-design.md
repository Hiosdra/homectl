# Slice 3 design: control-plane convergence across peers

Status: **design only, proposed.** Implementation was stopped at this step because the existing peer layer cannot carry execution state safely without a major refactor (see section 2). Nothing here is implemented or deployed. Branch `feat/issue-5-control-plane`, local only.

## 1. Requirements (from the coordinator)

- Plans, approvals and terminal states converge deterministically across peers.
- An approval or execution consumed on one peer is never replayed on another (single use across the federation). Execution ownership is defined, and the system fails closed when ownership cannot be established.
- Each peer keeps its own hash-chained audit journal. Replicated events carry origin peer id and origin sequence. A peer detects a rewritten or truncated replica.
- Conflicts surface in the existing Sync/conflict UI and CLI; they are never silently resolved where no safe rule exists.
- Client tokens and secrets never sync in plaintext. Revocation propagates.

## 2. What exists, and why it is not enough

Read in source (`src/peer/*`, verified 2026-11-05):

| Aspect | Current behaviour | Consequence for control-plane state |
| --- | --- | --- |
| Record namespaces | `validateRecords` accepts only `machine:`, `provider:`, `credential:`, `hostkey:`. `hub.snapshot` captures only those prefixes. | New namespaces need changes in validation, capture, snapshot and apply. |
| Merge | Per-record vector clocks. A dominating remote version overwrites local silently. Concurrent, unequal values become conflicts that need a human choice. | A generic overwrite could move an operation backwards (for example `executing` replaced by `approved`), which re-enables execution. The merge must be state-aware. |
| Conflict choice | `local`, `remote` or `both`. | "Use remote" on execution state would be unsafe. Execution state has no legitimate human choice. |
| Transport | Authenticated, encrypted messages keyed by a pairwise secret from pairing (`transportKey(secret, peer.key)`). | No per-device signature identity. Approval authenticity across three peers would need new key material or pairwise verification. |
| Trigger | Sync runs only when a person starts and applies a preview. | Convergence is eventual and manual, not continuous. Ownership decisions must not depend on a sync having happened. |
| Operation queue | `Hub.operations` is in memory (300 s, max 32). | Not a replicable model. The durable control-plane store (slice 1–2) is the right source of truth. |

Conclusion: the peer layer gives us authenticated transport, vector-clock bookkeeping and a human-review conflict surface. It does **not** give us state-aware merging, ownership, exactly-once consumption or cross-peer audit. Building those on top is the major refactor.

## 3. Proposed model

### 3.1 Replicated entities

- `control-op:<id>`: the operation record without argv secrets, plus `owner` (device id) and `ownerEpoch`.
- `control-approval:<id>`: approval id, operation id, fingerprint, issuer, approver device id, expiry, and `nonceDigest` (SHA-256 of the nonce). The nonce itself never leaves the owner.
- `control-tombstone:<id>`: revocation or handoff records.
- Client registrations: see 3.5.

### 3.2 Ownership

- Each operation has exactly one owner: the device where it was planned and where its target host is enrolled. Only the owner can move it to `executing` or to a terminal state.
- Owner transfer is an explicit handoff record, signed by the current owner and acknowledged by the new owner, with `ownerEpoch` incremented. Until both halves exist, nobody executes.
- Fail-closed rule: if a peer cannot establish the owner of an operation (missing handoff, two conflicting handoffs, owner unknown), the operation is shown as `needs-operator` on every peer and cannot run anywhere.

### 3.3 State lattice (merge rule)

Ranks: `pending(1) < approved(2) < executing(3) < succeeded|failed|unknown(4)`. Merging takes the higher rank. Terminal states never revert. A write from a non-owner that claims `executing` or a terminal state is rejected at receive, not offered as a conflict. Approval records are accepted only when signed by the approver device, and only while the operation is `pending`.

### 3.4 Single use across the federation

- Execution happens only on the owner, under the owner's local lock and nonce check (slice 1 rules).
- A replica can never execute an operation it does not own, so an approval copied to another peer has no execution path there.
- The owner must hold the consumed-nonce set before executing. If the owner has not seen the latest approval state, it still checks its own consumed set; a replica's stale view cannot re-enable a consumed nonce because replicas cannot execute.
- Two peers both online and one approval: approval replicates to the owner; the owner executes once. Approval on a non-owner while the owner is offline: the operation stays `approved`, shown as "awaiting owner"; it runs when the owner returns, and never runs elsewhere.

### 3.5 Client registrations and secrets

Options considered:

- **A. Device-local clients (recommended).** A client's token digest exists only on the device that created it. Only public metadata (id, name, scopes, host grants, created, status) replicates for display. Each client authenticates to one device. Revocation of a client is local to its device and is replicated as a tombstone so every panel shows it revoked. A federated identity (same client on several devices) is out of scope.
- **B. Replicate token digests.** Lets any device verify a client. Digests are not reversible, but they are verifiers, so they become credential-like material in the peer store. Needs its own review.
- **C. Replicate the registrations and the digests together with a shared client secret.** Rejected: plaintext-equivalent credential sync.

Recommendation: A. It matches "public metadata only" and keeps token material on one device. Revocation then means: the owning device refuses the token immediately, and the tombstone reaches peers. Without digest replication, no other device can accept that client anyway.

### 3.6 Audit across peers

- Each peer keeps its own chain (existing journal format). Events it receives are appended as `replica.received` with `originPeer`, `originSeq` and `originHash`, and the local chain covers them.
- Each peer stores, per origin, the last `(originSeq, originHash)` it has seen. A later replica that shows a lower sequence, or a different hash at a seen sequence, is reported as "origin journal rewritten or truncated" and blocks further trust in that origin until a person acknowledges it.
- The anchor idea from slice 2 extends per origin: the local anchor records the highest origin sequence applied.

### 3.7 Conflicts

- Lattice cases never conflict. Terminal and executing states are monotone.
- Client metadata edits made concurrently on different devices cannot happen under option A (a client lives on one device). Revocation wins over active.
- Two different handoffs for the same epoch, or two different approval records for one operation, are **conflicts**. They appear in the Sync preview with both versions, and the owner must be chosen by a person. No automatic choice.

## 4. Honest trade-offs

- Convergence happens when someone runs a sync (or the peers are connected under a future continuous mode). Between syncs, a remote approval waits, which is safe but slow.
- A two-peer deployment with the owner offline stalls execution by design. This is the price of exactly-once without a consensus protocol.
- Option A means a client cannot move between devices without re-enrolling.
- Per-origin replica checks detect rewriting after the fact; they do not prevent a fully compromised peer from forging its own chain.

## 5. Implementation plan (if approved)

1. Extend `validateRecords` and `capture` with the `control-*` prefixes, behind a feature flag. Tests on existing sync stay green.
2. Add the state-aware merge for `control-op`, with the lattice and receive-time owner checks.
3. Add signed handoff and approval records; device signing keys beyond the pairwise secret are required (open question 1).
4. Add replica audit events and per-origin checkpoints.
5. Surface conflicts (handoff, duplicate approval, `needs-operator`) in the Sync preview and `homectl sync`/`control` output.
6. Simulated multi-peer tests: two and three in-process peers, partitions, duplicate approvals, owner offline, rewritten replica.

## 6. Open questions

1. Device signing keys: is a per-device Ed25519 identity acceptable, or do we stay with pairwise secrets (authenticity then holds only between the two peers of each pair)?
2. Client registrations: do you accept option A (device-local, tombstones only), or do you want digest replication (B)?
3. Owner choice: planning device by default, or the device where the target host is enrolled? They differ when a host is shared.
4. Should a continuous sync mode be a prerequisite, or is the manual Sync flow acceptable for approvals?
5. Is the 2-peer stall (owner offline) acceptable operationally, or do you want a designated standby owner with explicit promotion?
