# homectl control-plane API v1 (slice 1)

Version: `homectl.control/v1`. Machine-readable contract: [`schema/control-plane.schema.json`](../../schema/control-plane.schema.json). TypeScript mirror: [`src/control/types.ts`](../../src/control/types.ts). Both are checked against each other by `tests/control-schema.test.ts`.

Status: **implemented in this branch, not deployed.** Tests show local behavior only. Plan and rationale: [inventory-and-plan.md](inventory-and-plan.md).

## 1. Actors, identities and scopes

| Actor | How it authenticates | Can do |
| --- | --- | --- |
| Client (for example "Codex PC", "Hermes Admin") | `Authorization: Bearer <token>` on the MCP endpoint. One token per client id. | Only operations covered by its scopes and host grants. |
| Local operator | The private CLI on the homectl host (OS account). | `execute` an approved operation; manage clients; verify the audit journal. |

- **Scopes** (closed set): `status:read`, `inspect:read`, `plan:create`, `approve:decide`.
- **Host grants**: explicit list of inventory host names per client. No wildcards.
- **Separation rules**: each client has its own id, token, scopes and grants. Tokens are never shared. A client cannot approve a plan it issued (`approver != issuer` for `decision: "approve"`). The issuer may still `reject` its own plan to cancel it.
- **Reserved client ids**: `local-operator` and `control-plane` (used for the local operator and system events in the audit journal).
- **Authentication interface**: `ClientAuthenticator.authenticate(credential) -> ClientIdentity | null`. Slice 1 implements token authentication; an OIDC implementation can replace it without changing the engine.
- **Token format and storage**: `hct_` + 32 random bytes (base64url). Only the SHA-256 digest is stored, in `control-plane/clients.json` (mode 0600 or owner-only ACL). The presented token's digest is compared with `timingSafeEqual` against every client record, without an early exit; only non-revoked records can match. Revocation takes effect on the next request.

## 2. Operations

Every request has an `op` field. Unknown fields are rejected. Each request is validated against the schema before any state is read.

| `op` | Actor | Scope and host grant | Mutates | Result |
| --- | --- | --- | --- | --- |
| `inspect` | client | `inspect:read`; grant for `host` if given | No (audit entry only) | Redacted machine view, or the list of granted hosts |
| `status` | client | `status:read`; grant for the operation's host | No (audit entry only) | `OperationView`, or granted-host operations |
| `plan` | client | `plan:create`; grant for `host` | Creates an operation in `pending` | `OperationView` (host, classification, redacted argv, impact, fingerprint, expiry) for review |
| `validate` | client | `inspect:read`; grant for the operation's host | No | `{valid, reason}` recomputed against current inventory |
| `approve` | client | `approve:decide`; grant for the operation's host; for `decision: "approve"` the approver must differ from the issuer | `pending -> approved`, or `pending -> failed` on reject | `ApprovalView` (no nonce) and `OperationView` |
| `execute` | **local operator only** | none (local OS account) | `approved -> executing -> succeeded / failed / unknown` | `OperationView` plus stdout/stderr for the local operator |
| `verify` | client | `status:read`; grant for the operation's host | No | Journal chain validity and per-operation consistency |

Rules that apply to all operations:

- Denied and unknown hosts, and unknown or ungranted operation ids, produce the **same** message. This prevents enumeration.
- A client that calls `execute` gets exit code 3, and so does a local operator calling anything other than `execute` through this API.
- Read-only operations never change operation, approval or client records. They append `request.accepted` to the audit journal.

## 3. Plan (immutable)

`ExecPlan` is created by `plan` and never edited.

| Field | Meaning |
| --- | --- |
| `host` | Inventory host name |
| `machine` | Snapshot of the inventory machine at plan time |
| `argv` | Exact argv (validated: 1–64 items, each 1–4096 characters, no NUL) |
| `impact` | Free text shown to the approver (up to 1000 characters) |
| `classification` | Existing `planExecution` classification: `inspect`, `mutation`, `destructive`, `opaque` |
| `needsApproval` | `true` unless `classification` is `inspect`. Inspection plans run without approval; mutations and destructive plans need a second client (slice 2, decision 1) |
| `execApproval` | Existing digest `hash({host, machine, argv, impact})` from `src/policies` |

**Fingerprint** (`fingerprint`): SHA-256 over canonical JSON (object keys sorted recursively, `undefined` dropped) of the plan body. Any change to host, machine policy, argv, impact or classification changes the fingerprint.

**Plan screening** (at `plan`; refusals are exit 3 unless noted):
- Unknown host: exit 2. Host not granted: exit 3 with the generic message.
- `full` access host: refused. There is no general-root path through MCP.
- Shell, interpreter and privilege-wrapper commands (for example `sh`, `bash`, `python3`, `env`, `xargs`, `su`, `doas`, `pkexec`, `ssh`) as the executable, including inside `sudo -n`: refused. `sudo -n` is accepted only when the existing `sudo-approved` allowlist matches. Commands the existing policy classifies as `opaque` (for example `curl`) are refused by the opaque rule.
- Argv referencing a container runtime socket (`docker.sock`, `/run/podman`): refused.
- Container and hypervisor control (`docker`, `podman`, `nerdctl`, `ctr`, `kubectl`, `qm`, `pct`, `pvesh`): allowed only when the existing classification is `inspect`.
- `opaque` classification: refused.
- Secret-like material in argv or impact (PEM private key headers, `password=`/`token:`/`secret=`-style assignments, `Bearer <value>`, `hct_` tokens): refused with exit 2. The value is not echoed.

## 4. Approval record

Created by `approve` with `decision: "approve"`.

| Field | Meaning |
| --- | --- |
| `id` | Random UUID |
| `operationId`, `fingerprint` | Bound to the reviewed plan. The caller must echo the fingerprint it reviewed. |
| `issuer` | Client that created the plan |
| `approver` | Client that approved. Must differ from `issuer`. |
| `issuedAt`, `expiresAt` | Epoch ms. Approval TTL is 5 minutes. |
| `nonce` | 128-bit random single-use token. Stored only; not returned to clients. |
| `state` | `active` until execution starts, then `consumed` |

Checks at `approve` (all exit 3 unless noted): operation exists and is granted; state is `pending`; plan not expired (reported as "Plan expired"); for `decision: "approve"` the approver is not the issuer; approver has `approve:decide` and the host grant; supplied fingerprint equals the stored fingerprint; stored plan re-hashes to its fingerprint (otherwise the operation is closed as `failed: integrity-mismatch`). A `reject` closes the operation as `failed: rejected` and journals both `operation.decided` and `operation.failed`.

At `execute` the approval is re-validated: it must be `active`, unexpired, its nonce absent from `consumedNonces`, its fingerprint equal to the operation's, the approver still active with the approve scope and host grant (otherwise `failed: approval-invalidated`), and the current inventory must still produce the same `execApproval` (otherwise `failed: stale-plan`).

## 5. Operation state machine

States: `pending`, `approved`, `executing`, `succeeded`, `failed`, `unknown`.

```text
pending --approve--> approved --execute--> executing --exit 0-----------> succeeded
   |                    |                      |  \--non-zero exit------> failed (exit-status)
   |                    |                      |  \--refused pre-spawn--> failed (refused-before-spawn)
   |                    |                      |  \--throw after spawn--> unknown (spawn-outcome-unknown)
   |                    |                      \----restart recovery----> unknown (interrupted)
   |--reject/expire-->  failed (rejected | plan-expired | integrity-mismatch)
   |                    |--expire/stale/invalid--> failed (approval-expired | stale-plan | approval-invalidated | integrity-mismatch)
```

- **Inspection shortcut (slice 2):** a plan with classification `inspect` goes `pending -> executing` directly when the local operator executes it, with no approval record and no nonce. Approval is refused for it. Mutation and destructive plans follow the path above.
- **Terminal states** are `succeeded`, `failed` and `unknown`. Nothing returns from them.
- **`failed` and `unknown` are never re-executed automatically.** A new plan and a new approval are required.
- `spawnAttempted` is set before the runner is invoked. `unknown` is the conservative answer when the engine cannot tell whether the remote command ran.
- Expiry is evaluated when a mutating request runs. Read-only views report `expired: true` for stale pending or approved operations without changing them.
- On startup (`ControlPlane.init`), an operation recorded as `executing` is closed as `unknown: interrupted` **unless** its recorded `executorPid` is still alive, in which case it is left alone. A reused PID can keep an orphaned operation in `executing` until restart; this fails safe (nothing is re-run).

## 6. Idempotency and replay

- `plan` may carry `idempotencyKey` (`[A-Za-z0-9._:-]`, 1–128). The key is scoped to the client id. The same key with the same request returns the existing operation without creating another. The same key with a different request is refused (exit 3).
- Approval is single-decision: a second `approve` on a non-pending operation is refused.
- Execution is single-use: `approved -> executing` happens once under the state lock, the nonce is consumed in the same write, and a second `execute` is refused (exit 3 for states other than `approved`; exit 4 when not yet approved).
- Concurrent callers are serialized by an exclusive lock file in `control-plane/`. The lock is held for state transitions only, never while a command runs.

## 7. Audit journal

File: `control-plane/audit.jsonl`, one JSON object per line, append-only.

```json
{"v":1,"seq":7,"at":"2026-11-05T10:00:00.000Z","prev":"<hex64>","hash":"<hex64>","event":{"event":"operation.planned","client":"codex-pc","operationId":"<uuid>","host":"lab-printer","argv":["uname","-s"],"fingerprint":"<hex64>","classification":"inspect"}}
```

- `hash = SHA-256(canonical JSON of {v, seq, at, prev, event})`. `prev` of the first entry is 64 zeros. `seq` starts at 1 and increments by 1.
- Events: `auth.rejected`, `request.accepted`, `request.rejected`, `client.created`, `client.revoked`, `operation.planned`, `operation.decided`, `operation.executing`, `operation.succeeded`, `operation.failed`, `operation.unknown`.
- Event payloads contain ids, the fixed reason codes listed above, fingerprints and redacted argv. They never contain tokens, nonces, impact text, stdout or stderr.
- Before every append the payload is checked for secret-like material; a match aborts the write (fail closed).
- Verification (`homectl control audit verify`) recomputes the chain, then checks it against `control-plane/audit.anchor`. The anchor holds the latest `{seq, hash}` and is rewritten after every append. Verification fails when the journal is shorter than the anchor (tail truncation), diverges from it, or when the anchor is missing for a non-empty journal. Appends refuse in the same conditions. **Limit:** an attacker who can rewrite both files consistently is not detected; see inventory-and-plan R1.
- Corrupt journal: appends are refused until an operator repairs or moves the file.

## 8. Error mapping

| Code | Meaning in the control plane |
| --- | --- |
| 2 | Invalid request (schema), unknown host or operation id where the caller is entitled to know it, invalid input |
| 3 | Forbidden: missing scope or grant, self-approval, policy refusal, state conflict, fingerprint mismatch, replay, expired or invalid approval |
| 4 | Approval required before execution |
| 5 | Unavailable: state lock busy, audit journal unavailable or corrupt, internal failure (details suppressed); also `control execute` ending `unknown` |
| 6 | `control execute` ran and the command exited non-zero (`failed` with an exit code) |

`control execute` exit mapping: `succeeded` 0; `failed` with exit code 6; `failed` before spawn 3; `unknown` 5.

Error messages are fixed strings in the engine. Exception text from lower layers is not forwarded.

## 9. MCP surface (Streamable HTTP, JSON-RPC 2.0)

- Endpoint: `POST http://127.0.0.1:<port>/mcp`. Default port 7449 (`homectl serve-mcp --port`). Bound to `127.0.0.1` only; other addresses are refused in code.
- Protocol versions accepted in `initialize`: `2025-06-18`, `2025-03-26`. The server answers with the requested version if supported, otherwise `2025-06-18`.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications receive `202`. Batches are refused. `GET` returns `405`.
- Every request needs `Authorization: Bearer <token>`. Missing or invalid tokens return `401` with `WWW-Authenticate: Bearer`. Revoked clients are refused.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; an `Origin` header, if present, must match. Otherwise `403`.
- Stateless: no `Mcp-Session-Id`. Request body limit 256 KiB; larger bodies receive `413` before parsing (tested).
- `tools/call` results carry a one-sentence summary in `content[0].text` (with the full operation id and fingerprint, so an approver agent can act on it) and the typed result in `structuredContent`. Timestamps in `structuredContent` are ISO-8601 UTC strings. Errors keep their fixed message and code.
- `tools/list` shows only tools whose scope the client holds. `tools/call` enforces scope again in the engine.

| Tool | Scope | Maps to | Read-only hint |
| --- | --- | --- | --- |
| `homectl_inspect` | `inspect:read` | `inspect` | yes |
| `homectl_status` | `status:read` | `status` | yes |
| `homectl_plan` | `plan:create` | `plan` | no |
| `homectl_approve` | `approve:decide` | `approve` | no |

There is no execute tool, no shell tool, and no tool that creates clients or reads secrets. Tool errors use `isError: true` with the engine's fixed message and code.

## 10. Local operator commands

These run in the homectl host's terminal. They do not go through MCP.

```sh
homectl serve-mcp [--port 7449] [--inventory PATH]
homectl control client add <id> --name "Codex PC" --scopes status:read,inspect:read,plan:create --hosts lab-printer --token-file PATH
homectl control client list [--json]
homectl control client revoke <id>
homectl control ops [--state pending,approved] [--all]
homectl control show <operation-id-or-prefix>
homectl control execute <operation-id-or-prefix>
homectl control audit verify
```

- `client add` writes the token to `--token-file` with owner-only permissions and refuses to overwrite an existing file. The token is never printed. The destination directory must exist and the file must not exist; both are checked before any client is created. Hosts in `--hosts` must exist in the inventory; unknown names are refused with the list of valid names (exit 2). If the file cannot be written after creation, the new client is revoked. The human output prints a ready-to-paste MCP client snippet with a placeholder header, never the token.
- `client list` shows an aligned table (ID, NAME, SCOPES, HOSTS, CREATED, STATUS). Revoked clients are listed last and dimmed.
- `client revoke` is idempotent: revoking an already revoked client reports that nothing changed. In an interactive terminal (not with `--json`) it asks for confirmation first.
- `ops` lists open operations by default (pending, approved, executing); `--all` includes history and `--state` filters by state. `show` and `execute` accept a unique id prefix of at least 8 characters.
- `execute` refreshes the managed SSH config first (as `exec` does), then runs the existing `src/operations.ts` `execute()` path, so the existing tier and classification checks still apply. The human summary shows the outcome, the command, and stdout/stderr blocks (or `(no output)`). Output is printed to the operator and is not stored.
- Human output uses local time (`2026-11-05 21:55:40`) and relative times. Colors are used only on an interactive terminal and are disabled by `NO_COLOR`. `--json` output keeps the same structure and uses ISO-8601 timestamps.
- `serve-mcp` binds only to `127.0.0.1`. `--host` with any other value is refused with an explanation (use a reverse proxy or tunnel for remote clients). A busy port reports `Port N is already in use`.
- `--name`, `--scopes`, `--hosts`, `--token-file`, `--state` and `--all` apply only to `control`; `--host` applies only to `serve-mcp`. Other commands refuse them with exit 2.

## 12. Five-minute quickstart

1. Add two clients, one per agent, each with its own token file:

   ```sh
   homectl control client add codex-pc --name "Codex PC" --scopes status:read,inspect:read,plan:create --hosts agent-host --token-file ~/.config/homectl/tokens/codex-pc.token
   homectl control client add hermes-admin --name "Hermes Admin" --scopes status:read,inspect:read,approve:decide --hosts agent-host --token-file ~/.config/homectl/tokens/hermes-admin.token
   ```

2. Start the endpoint in a private terminal and leave it running: `homectl serve-mcp`.
3. Configure each MCP client with the URL `http://127.0.0.1:7449/mcp` and the header `Authorization: Bearer <contents of its token file>`. The snippet printed by `client add` shows the shape.
4. The Codex client plans: `homectl_plan` with `host: "agent-host"` and `argv: ["hostname"]`. An inspection plan needs no approval.
5. Run it: `homectl control execute <first 8 characters of the id>`, or open **Approvals** in the local panel and press Execute.
6. For a change (for example `argv: ["systemctl", "restart", "nginx"]`), the Hermes client approves the exact fingerprint with `homectl_approve`; then run it with `homectl control execute`, or Execute in the panel.
7. Check the trail: `homectl control audit verify` (or the Audit card in the panel).

## 13. Local panel: Approvals

The local panel (`homectl serve`, `homectl panel`) has an **Approvals** view with three parts:

- **Operations**: Pending, Approved and History filters. Rows show state, host, classification, command, impact, issuer → approver, when, and a short fingerprint. Pending changes show "Waiting for approval by another client". Ready operations show **Execute**, which opens a confirmation with host, command, impact, fingerprint and approver. The result appears inline with exit code and collapsed stdout/stderr.
- **Clients**: scopes and host grants as chips, status, and **Revoke** (with confirmation). Adding clients stays in a terminal; the panel shows the command to copy.
- **Audit**: the verification status with **Verify now**.

The panel's control routes (all behind the existing local session cookie and origin checks) are `GET /api/control`, `POST /api/control/execute`, `POST /api/control/revoke` and `POST /api/control/audit/verify`. **The panel never approves on behalf of a client**: there is no approve route, and approval stays a separate client identity. Execution through the panel uses the same local-operator path as the CLI and is audited the same way.

## 14. Slice 2 decisions

1. **Inspection runs without a second client.** A plan whose classification is `inspect` has `needsApproval: false` and can be executed by the local operator (CLI or panel) without an approval record. It stays fully audited: `operation.executing` carries `reason: "no-approval-required"`, the operation is single-use, and approval is refused for it (it needs none). Mutation and destructive plans still need approval by another client. Before this change, `needsApproval` could say `false` while execution still required approval; the flag is now derived from the classification so the two always agree.
2. **API timestamps are ISO-8601 UTC strings** (`createdAt`, `expiresAt`, `updatedAt`, `issuedAt`) in every view and in `structuredContent`. Records on disk keep epoch milliseconds.
3. **MCP tool text is a summary**, with the full operation id and fingerprint in the sentence, so an approver agent can act on it. `structuredContent` carries the full typed result.
4. **Audit truncation is detected** through `audit.anchor` (see section 7).

## 11. Non-goals in this version

- Remote execution, output streaming or result retrieval for clients.
- OAuth/OIDC, TLS, non-loopback binding, or Authentik integration.
- Peer synchronization of control-plane state.
- Signing keys for plans or journal anchoring (see risks R1–R2 in the plan).
- Proxmox lifecycle or LXC control.

## 12. Replicated view (ADR-0002 stages c and d)

Operation views gain optional fields when this device is part of a replicated control plane: `ownerName`, `runsOn` (set when another device owns the operation), `remote` (held only by another device), `conflict` (no owner), `takeover` (`possible`, `reason`, and `at` for the earliest time), `delivery` (a forwarded approval: `awaiting-confirmation`, `approved` or `rejected`), and `approvedBy` (`"<client> (via <device>)"`). MCP status returns the same fields in `structuredContent`, and the summary text names the owner and any forwarded approval.

Execution on a device that does not own an operation is refused with exit 3 and the owner's name. Approval on a device that does not hold the operation is forwarded to the owner and reported as "Approval forwarded to owner <device>; it applies after the next sync".

Local operator routes (panel gate: launch token, session cookie, loopback Host, same-origin POST). They are not on the peer channel and not on MCP:

- `GET /api/control/sync`: per-device sync status, backoff, lease, refusals, conflicts and blocked logs. Returns an error when control sync is not running.
- `POST /api/control/handoff` with `{ "operationId": "...", "to": "<device>" }`: on the owner, offers the operation to `to` (owner refuses to run it while the offer is open). On the named receiver, without `to`, accepts the pending offer. Otherwise it is a takeover of an unreachable owner, and `to` must name this device.
- `POST /api/control/handoff` with `{ "operationId": "...", "cancel": true }`: withdraws an open offer that nobody has accepted.
- `POST /api/control/peer` with `{ "target": "<device>", "suspend": true, "reason": "..." }`: suspends a paired device from this device's lease (`suspend: false` resumes it). The record is signed and replicated; the reason is short text with no secret material.
- `POST /api/control/resolve` with `{ "operationId": "...", "owner": "<device>" }`: proposes a winner for an ownership conflict. Without `owner`, the named winner's pending resolution is accepted here.

CLI: `homectl control sync` (falls back to the saved state when serve is not running), `homectl control handoff <id> --to <device>` and `--cancel`, `homectl control resolve <id> --owner <device>` (these need a running serve).

Audit events for ownership changes: `handoff.offered`, `handoff.cancelled`, `handoff.accepted`, `handoff.resolution-proposed`, `handoff.resolution-accepted`. Each carries the operation id, host and a fixed reason; device identifiers appear only in the reason text. See [replicated-quickstart.md](replicated-quickstart.md).

Follow-up additions: `peer.suspended` and `peer.resumed` audit events; `offerExpires` on operation views (an open offer expires 15 minutes after it is made); `suspended` on device rows in the sync view. See [replicated-quickstart.md](replicated-quickstart.md).
