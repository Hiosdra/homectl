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
- **Token format and storage**: `hct_` + 32 random bytes (base64url). Only the SHA-256 digest is stored, in `control-plane/clients.json` (mode 0600 or owner-only ACL). Comparison is constant-time (`timingSafeEqual`) over all non-revoked clients. Revocation takes effect on the next request.

## 2. Operations

Every request has an `op` field. Unknown fields are rejected. Each request is validated against the schema before any state is read.

| `op` | Actor | Scope and host grant | Mutates | Result |
| --- | --- | --- | --- | --- |
| `inspect` | client | `inspect:read`; grant for `host` if given | No (audit entry only) | Redacted machine view, or the list of granted hosts |
| `status` | client | `status:read`; grant for the operation's host | No (audit entry only) | `OperationView`, or granted-host operations |
| `plan` | client | `plan:create`; grant for `host` | Creates an operation in `pending` | `OperationView` with `review` fields |
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
| `needsApproval` | Existing policy flag. Control-plane approval is required regardless (see decision 1 in the plan) |
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
- Verification (`homectl control audit verify`) recomputes the chain and reports the first broken sequence number. **Tail truncation is not detectable from the journal alone** (see inventory-and-plan R1).
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
homectl control client list
homectl control client revoke <id>
homectl control execute <operation-id>
homectl control audit verify
```

- `client add` writes the token to `--token-file` with owner-only permissions and refuses to overwrite an existing file. The token is never printed. The destination directory must exist and the file must not exist; both are checked before any client is created. If the file cannot be written after creation, the new client is revoked.
- `--name`, `--scopes`, `--hosts` and `--token-file` apply only to `control`; other commands refuse them with exit 2.
- `execute` refreshes the managed SSH config first (as `exec` does), then runs the existing `src/operations.ts` `execute()` path, so the existing tier and classification checks still apply. Its stdout and stderr are printed to the operator and are not stored.

## 11. Non-goals in this version

- Remote execution, output streaming or result retrieval for clients.
- OAuth/OIDC, TLS, non-loopback binding, or Authentik integration.
- Peer synchronization of control-plane state.
- Signing keys for plans or journal anchoring (see risks R1–R2 in the plan).
- Proxmox lifecycle or LXC control.
