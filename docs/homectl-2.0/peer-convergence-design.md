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

## 7. Decisions (homelab ADR-0002) and implementation status

The owner decided the open questions in section 6. Recorded in homelab ADR-0002:

1. Per-device Ed25519 signing identity. Private key stored locally, never synced or logged; public key exchanged inside the authenticated pairing messages, with a fingerprint for out-of-band verification.
2. Option A: client registrations stay device-local. Only public metadata and revocation tombstones replicate.
3. Owner is the planning device. Only the owner enforces single use and executes. Ownership moves only by an explicit signed handoff.
4. Continuous sync is a prerequisite for cross-peer approvals.
5. An offline owner's operations wait, or an operator takes them over explicitly (signed, audited handoff). No automatic standby.

Implementation status on `feat/issue-5-control-plane`:

- Stage (a), done: device keys (`src/control/device-key.ts`), public key carried in pairing identities and stored on paired peers, fingerprint helper. Tests: `tests/control-device.test.ts`.
- Stage (b), done: signed record envelope and state-aware rules (`src/control/replicate.ts`): lattice pending < approved < executing < terminal per owner epoch; owner-only state writes; snapshots below the established epoch are stale; handoffs signed by the taking device; conflicting handoffs at one epoch are kept as conflicts with no owner; decisions signed by the approver's device and applied at most once; monotone client revocation. Tests: `tests/control-replicate.test.ts`.
- Stage (c), done: continuous sync loop, engine integration (adopting an operation on takeover, routing approvals from non-owner devices, an execute-time owner guard), per-origin log checkpoints, and convergence tests (see section 8).
- Stage (d), done with gaps: CLI (`control handoff`, `control sync`), panel surfacing, local admin route (see section 9).
- Stage (e), done: quickstart for replicated mode (see section 10).

Known gaps to close in stage (c):

- Takeover needs the destination device to rebuild the operation from the replicated plan. That requires the same host to be enrolled there, and a fresh approval record on the new owner. Without that, the operation cannot run anywhere and must stay visibly stuck.
- Race: an old owner that comes back and executes before it has received the takeover can run the operation twice. A safe rule needs the owner to confirm it is current before executing. Until that is designed, this stays a documented risk.

## 8. Fencing rule: lease and takeover (refines ADR-0002 decision 5)

Decision 5 allowed an operator to take over an offline owner. It left one race open: an old owner that returns and executes before it has learned about the takeover could run the same operation twice. The owner resolved this on the stage (c) run, and the rule below is implemented in `src/control/lease.ts`, `src/control/replicator.ts` (`fence`, `takeover`) and the engine's execute path.

1. Lease. The owner may execute only while it holds a fresh lease: a successful sync round with every paired peer within T (default 120 s). With no paired peers there is no other owner, so no lease applies. An expired lease refuses execution with "Owner lease expired; waiting for sync with <peers>" (exit 3).
2. Takeover window. A takeover is allowed only when the owner has been unreachable for at least T plus a skew margin (default 60 s). Without any recorded contact, takeover is refused. The CLI and panel show when takeover becomes possible.
3. Fence before spawn. The fence (lease, current owner and established epoch) is evaluated inside the state lock, before the operation is committed to `executing`. A returning former owner therefore cannot run an operation: its lease is stale until it syncs, and after sync it sees the new epoch and loses ownership.
4. Takeover rebuild. The new owner must have the target host in its own inventory, or the takeover is refused with a clear message. Its plan is rebuilt from its own inventory. The operation returns to needs-approval on the new owner, because the old approval is bound to the old epoch's fingerprint. This is visible in the operation's state and must be shown in the CLI and panel.
5. Conflicting takeovers. Two different takeovers at the same epoch leave the operation with no owner. Neither device can execute until an operator resolves the conflict (stage d).

Tests (`tests/control-convergence.test.ts`): old owner offline, takeover refused inside the window, takeover accepted after it, the returning owner refused both by lease and by ownership, the new owner's operation back in needs-approval, a host missing on the new owner refusing the takeover, and two takeovers at one epoch leaving both devices unable to run.

Status of stage (c): done and tested. The lease and takeover window, per-origin checkpoints, the replicator, the continuous sync scheduler with backoff, the hub's `control-exchange` action on the authenticated peer channel, the scheduler timer in `serve`, MCP approvals forwarded from a non-owner device, and a two-device end-to-end test over the real peer channel (`tests/control-e2e.test.ts`).

## 9. Stage (d): CLI and panel surfacing

Implemented on the same branch:

- Local admin route. `serve` exposes `GET /api/control/sync` and `POST /api/control/handoff` behind the existing panel gate: the launch token in `serve/panel.json` exchanged for a session cookie, a loopback Host check, and a same-origin check on POST. Neither route is reachable from the peer channel or MCP. The CLI reads the token file itself and never prints it. `serve` removes `panel.json` on stop, so a stale token is not left behind.
- `homectl control sync`: per-device last sync, lease, backoff, refusals, conflicts and blocked logs. Without a running `serve` it shows the last saved replica and says "serve not running — showing last saved state; backoff unknown".
- `homectl control handoff OP --to DEVICE`: needs a running `serve`. A handoff is signed by the device that takes over (`replicate.ts`), so `--to` must name the device running the command; otherwise the command refuses and says where to run it. The receiving device must have the host in its inventory, and the takeover window must be open.
- Without a running `serve`, the CLI applies the same fence as the engine, reading the saved replica. A paired owner whose lease has lapsed therefore cannot execute from the CLI either. This is a deliberate change: before stage (d) the CLI executed without any fence.
- Operations held by another device show "Runs on <device>" in the CLI, the MCP status, and the panel. They are never executed from a non-owner. Takeover shows its earliest time, or the reason it is unavailable (no recent contact, host not enrolled here, conflict).
- Forwarded approvals are tracked until the owner's replicated state reflects them: "approval forwarded to <owner>, awaiting confirmation", then "approved by <client> (via <device>)". Rejections are confirmed the same way. No new protocol was needed.
- Panel: owner per operation, "Runs on <device>" instead of Execute, takeover behind a confirmation, a Control sync section in the Sync view (peers, backoff, lease, refusals, conflicts), signing fingerprints in Devices, and a re-pair hint for peers without a signing key. The Approvals badge counts only operations this device can run.
- Device key files: on POSIX, a key that other users can read is refused at load. On Windows the ACL is set at creation and not re-checked on every load.
- `--no-discovery` disables multicast discovery only; control sync with already-paired devices keeps running.

Gaps after the first stage (d) run were closed in the final round (section 11).

## 10. Stage (e): replicated mode

See [`replicated-quickstart.md`](replicated-quickstart.md) for setup, the lease and takeover rules, and troubleshooting ("why can't I execute?").

## 11. Final round: two-signature handoff, resolution, legacy lease rule

Decisions implemented (`src/control/replicate.ts`, `src/control/replicator.ts`, `src/serve.ts`):

1. Cooperative handoff. Records: `offer` (signed by the owner, names the receiver, epoch = established + 1), `cancel` (signed by the owner), `accept` (signed by the receiver). An accept starts the new epoch through the same handoff record store as takeover. Rules: one open offer per operation; a cancel applies only to an offer with no accept; an accept applies only to an open, uncancelled offer at the epoch it names; the owner's fence refuses execution from the offer on. The receiver's accept takes the operation as pending, so it needs a fresh approval.
2. Conflict resolution. Records: `resolve` (signed by a device involved in the conflict; the winner must be a candidate) and `resolve-accept` (signed by the winner). A resolution applies at epoch conflict + 1 only after the winner's accept. A second, different resolution at the same epoch produces a new conflict at that epoch, visible in the Sync view.
3. Legacy peers. A peer without a signing key is excluded from the lease set and never counts as synced. Sync and `control sync` show it as excluded. Signing peers still block their peers when they stop syncing; that is unchanged and documented as the fail-closed rule.
4. Pull application. Records that depend on another origin in the same pull (a resolution on a conflict, an accept on an offer) can arrive first. A rejected record is retried until a pass makes no progress, because the origin's checkpoint moves on and would never resend it. Without this, two devices could disagree after a pull.
5. Audit. Offer, cancel, accept and both resolution steps are written to the local journal (`handoff.*` events, identifiers and fixed reasons only). Schema updated.
6. Admin hardening. `/api/connect` and the session cookie compare in constant time. The POSIX key-mode error no longer prints the key path. `--no-control-sync` switches off the peer receiver, the scheduler and its timer together.

Follow-up round (section 12) changed these:

- Suspension, the operator's answer to an offline signing peer, is described in section 12.
- Offers expire after five minutes, clamped to the plan or approval expiry, as section 12 describes.

Known residual risks, not closed by this round:

- Cancel versus accept race: an accept signed before the receiver saw the cancel is applied on the receiver and rejected on the owner. The divergence is visible to an operator and needs a fresh approval to run, but it is not automatically reconciled.
- An offline signing peer blocks execution on its peers after the lease window. This is the fail-closed rule from section 8. The suspend action in section 12 is the operator's answer.
- Owner-side route for the MCP view: remote operations show device names to MCP clients that hold the host. Names are not secrets, but they are device identifiers.

## 12. Follow-up: suspension from the lease, offer expiry

Decided by the owner for the offline-device case, and implemented:

1. Suspend. `control peer suspend DEVICE [--reason TEXT]` (or "Suspend from lease" in the Sync view, behind a confirm that says operations here may run without the device confirming the latest state). The suspension is a signed `suspension` record, replicated to every device; only the suspending device excludes the peer from its own lease. Other devices show it as "suspended by <device> at <time>". Audited locally as `peer.suspended` with the device id and a short reason.
2. Resume. Automatic on the next successful control sync with the peer (audited as `peer.resumed`, reason `synced`), so the peer counts toward the lease again. Manual: `control peer resume DEVICE` or "Resume" in the Sync view.
3. Safety, unchanged rules: a suspended peer cannot run operations the suspending device owns (the fence refuses them as "runs on <owner>"). A handoff to a suspended peer is refused until it resumes, and so is an accept by a device its owner has suspended. When a suspended peer comes back, its own lease still requires a sync before it runs anything.
4. Offer expiry. An open handoff offer expires at min(five minutes after it is made, the plan or approval expiry). The expiry is signed in the offer, so every device agrees. `OFFER_TTL_MS` is the five-minute constant; there is no setting for it. Expiry uses the signed timestamps, so every device agrees: an accept signed after expiry is rejected everywhere, and the receiver's own check refuses an expired offer. After expiry the owner's fence no longer refuses execution, and the next offer cancels the expired one first. The panel and CLI show "offer expires in N min" and "offer expired".
5. Conflict rows in the Sync view put the description, the owner select and the Resolve button on one aligned row, wrapping on narrow screens.

Tests: `tests/control-suspend.test.ts` (an offline signing peer blocks execution; after suspend, execution works and is audited; the suspension replicates to a third peer; the peer comes back, syncs, is auto-resumed and counts again; a suspended peer must sync before it runs; a suspended peer cannot run the owner's operation; a handoff to a suspended peer is refused until resumed; double suspend and resume of a non-suspended peer are refused; an expired offer restores the owner's fence; a late accept is rejected).

Residual risk, not closed: suspension is a local operator decision with no consent from the suspended device. Its only protection is the device's own lease when it comes back, plus the audit trail on both sides.

## 13. Slice 3 close-out: offer lifetime and finished operations

- Offer lifetime is five minutes (`OFFER_TTL_MS`), shorter than the 15-minute plan lifetime. The owner signs `expiresAt = min(at + 5 min, plan expiry, approval expiry)` into the offer, and peers reject an offer whose lifetime exceeds five minutes. An offer therefore never outlives the operation it hands off.
- A finished or running operation cannot change owner. Offers, accepts, takeovers and resolutions are refused for it, and no snapshot may move a finished operation back to an earlier state, whatever its epoch.
- Accept race. An accept signed before expiry, arriving after the owner executed, is rejected on the owner and on any third device that has the finished state (`tests/control-handoff.test.ts`). The window is narrow: the owner may run only within its 120 s lease, so the accept has to be signed after the owner's last sync and the owner has to run after the expiry, inside that lease.
- Residual, unchanged: the accepting device itself. If it accepted before it saw the owner's finished state, it still shows itself as owner until the operator reconciles. Closing that needs the owner's acknowledgement, a separate design.

## Plan signatures (added with the signed-plan change)

- The device that plans an operation signs the plan fingerprint with its Ed25519 device key. The signature and the signer's public key are stored on the operation record (`planSignature`, `planSignerKey`, `planSignatureSource`).
- Execution fails closed. A record runs only when its signature verifies over the fingerprint. For a `local` record, the signer key must be this device's own key. A `replica` record is adopted only when the replicator checks the signature against the planner's key in the device registry.
- Wire format: the operation body carries an optional `planSignature`. Peers built before this change never send it and ignore it. A receiver with no valid signature adopts the plan unsigned, and it cannot execute the plan. Takeover of a plan from an older peer therefore needs a new plan. This is deliberate.
- Limit: a process running as the same user can read the device key and sign anything. The signature protects against changes made to state without the key, for example a copied or edited state file.
