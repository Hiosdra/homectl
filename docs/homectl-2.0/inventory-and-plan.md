# homectl 2.0 — inventory and plan (slice 1)

Status: **planning record for the first implementation slice** on branch `feat/issue-5-control-plane`. Tracking issue: Hiosdra/homelab#5. This document describes the repository as read on 2026-11-05 and the design chosen for slice 1. It is not a deployment record and does not claim that any of the planned behavior runs on a live host.

Scope of this slice: deliverable 1 (inventory, plan, frozen control-plane API) and the local core of deliverable 2 (approval engine, audit journal, client authentication, loopback MCP server, optional CLI entry points). Out of scope: peer sync/conflict/recovery, Proxmox lifecycle adapters, Ugreen container onboarding, OAuth/OIDC with Authentik, deployment workflow.

Labels used below: **Read in source** (checked by reading files), **Ran** (checked by executing a command in this checkout), **Not verified** (stated but not checked).

## 1. What exists today

### 1.1 CLI surface (Read in source: `src/cli/main.ts`, `src/cli/help.ts`)

| Area | Commands |
| --- | --- |
| Setup | `update`, `setup [--install-deps] [--configure-firewall]`, `doctor [host]` |
| Inventory | `hosts`, `inspect <host>`, `enroll <host> --file`, `sudoers <host>` |
| Session | `session configure|init|unlock|lock|status`, `key create|inspect <name>` |
| Remote command | `exec <host> [--impact] [--approval DIGEST] -- <argv>`, `ssh` (alias of `exec`) |
| Provisioning | `provision --file` (Proxmox over SSH) |
| Local workspace | `serve`, `panel`, `service <action>`, `pair ...`, `peers`, `sync preview|apply|cancel`, `peer <id> --target <host> -- <argv>` |

Global flags include `--json`, `--dry-run`, `--inventory PATH`. Exit codes (Read in source, help text): 0 success, 2 input, 3 policy, 4 confirmation, 5 transport/setup, 6 remote command failure. Every command except `help`/`setup`/`update`/`serve`/`pair`/`peers`/`sync`/`peer`/`service`/`panel` loads the inventory first.

### 1.2 Exec and approval digest flow (Read in source: `src/policies/index.ts`, `src/operations.ts`)

1. `planExecution(host, machine, argv, impact)` enforces tier rules (observe, user, sudo-approved exact allowlist, full), rejects privilege wrappers for non-full tiers, and classifies argv as `inspect | mutation | destructive | opaque`.
2. `needsApproval` is true only for `destructive` and `opaque`. **Inspect and mutation argv run without an approval digest** (mutation is not approval-gated in the CLI path).
3. `approval = hash({host, machine, argv, impact})` where `hash` is SHA-256 over `JSON.stringify` (key-order dependent).
4. `checkApproval` compares the caller-supplied digest. A mismatch throws exit code 4 with the expected digest in `details`.
5. `execute()` runs the policy checks, applies a root refusal for non-full local tiers, builds the SSH spec through `transports` and `credentials`, and calls the injected `Runner`. Nothing records the attempt.

Observation: `execute()` can throw after the runner has spawned a process (for example, a locked session is detected from worker stderr and thrown as code 5 after the spawn). A caller cannot distinguish "never spawned" from "spawned, outcome unknown" from the thrown error alone.

### 1.3 Access tiers (Read in source: `src/types.ts`, `schema/inventory.schema.json`, `docs/user-guide.md`)

`observe | user | sudo-approved | full`. Enforced in `planExecution` and inventory validation (root SSH requires `full`; `sudo-approved` requires exact `sudo_allow` argv). Documentation states tiers are workflow protection and do not sandbox the account (Read in source: `docs/architecture.md`).

### 1.4 Peer workspace (Read in source: `src/serve.ts`, `src/peer/*`)

- `serve` runs a localhost-only authenticated panel (`127.0.0.1:7447`, token + HttpOnly cookie, `Origin` and `Host` checks) and an explicit-interface peer listener (`7448`).
- Peer trust: SRP-6a pairing with dual confirmation; subsequent messages use X25519/HKDF/AES-256-GCM envelopes with single-use challenges.
- `peer/store.ts` persists trust, grants and revision metadata to `peers.json` (mode 0600 / Windows ACL), redacting credential values to fingerprints.
- Remote operations: `Hub.handle('exec')` in `src/peer/hub.ts` requires a per-host operation grant. Mutations (non-inspect classification) are queued **in memory** (`Hub.operations`, 300 s expiry, max 32 entries) and wait for local approval. `decideOperation` recomputes `planExecution` and compares digests, then sets `state = 'done'` **before** calling `execute()`; on failure it stores an error string. Restart loses the queue. No audit log.
- Results: `operation-status` returns state and result to the requester.

### 1.5 Provisioners (Read in source: `src/provisioners/index.ts`, `src/provisioners/ssh.ts`)

Deterministic Proxmox plan with a `fingerprint`. Apply writes a per-VMID JSON journal (`{fingerprint, complete[], pending?, cloneStarted?}`) in the state directory, refuses fingerprint mismatch, checks VM ownership by a description marker, and never deletes VMs. This is the only durable journal pattern in the repository today, and it is not hash-chained. Proxmox adapter is `pvesh` over SSH only; no LXC/`pct` lifecycle support exists in code (`pct` appears only in the destructive-classification list).

### 1.6 Session daemon and credentials (Read in source: `src/session/*`, `src/credentials/*`)

- `session/daemon.ts` runs a per-inventory dedicated agent (OpenSSH `ssh-agent` on Unix, native named-pipe Ed25519 agent on Windows) with an absolute expiry and a small control socket (`status`, `lock`).
- The daemon holds no database password. `credentials/worker.ts` checks session status and launches OpenSSH only with the inventory's dedicated socket.
- Secrets: `credentials/index.ts` `redactor` and `cleanEnv` allowlist. Plain-text secrets are never stored in the inventory (schema rejects extra fields).

### 1.7 Persistence and permissions (Read in source: `src/platform.ts`)

- `privateDirectory(path)` and `protect(path)` set POSIX modes or Windows owner/SYSTEM ACLs. **On Windows each call spawns `powershell.exe`**, so calling them per write is expensive. Existing `saveState` calls `protect` on every save.
- `saveInventory` and `saveState` use temp file + rename.

### 1.8 Schema and tests (Read in source: `schema/`, `tests/`)

- `schema/inventory.schema.json` is JSON Schema draft-07, validated with Ajv 8 (`strict: false`, `allErrors: true`) in `src/inventory/index.ts`. Biome lints `schema/**/*.json`.
- Tests: 14 files, Bun test runner. `tests/cli.test.ts` spawns the CLI with temp inventories. Peer tests start `serve` on port 0.
- CI (`.github/workflows/ci.yml`): Ubuntu runs typecheck, lint, full `bun test` and Playwright UI smoke; Windows runs a named subset of test files plus PowerShell CLI smoke.

### 1.9 Baseline checks in this checkout

- **Ran**: `bun --version` = 1.4.4; `bun install --frozen-lockfile` OK; `bun run typecheck` pass; `bun run lint` pass (63 files).
- **Ran**: `bun test` on this Windows machine. Two runs, failing sets differed between runs. Failures are in session/KDBX/SSH-agent/Windows-ACL areas (for example "default session configuration uses a local database and 24h TTL", "real KDBX unlock loads a signing key", "managed worker rejects a locked session before launching SSH", "safe command emits result and exit 0", "remote mutations wait for local approval and are cancelled by revoked grants", "session startup refuses a symlinked runtime directory"). First run: 151 pass, 6 fail, 1 error (of 157 tests). **These are pre-existing and environment-dependent; they were not investigated in this slice.** Final results are reported separately.

## 2. What homectl 2.0 slice 1 changes

| Requirement (issue #5, approved) | Slice 1 design | Where |
| --- | --- | --- |
| Separate per-client identities and scopes; no shared grants; no self-approval | Each client has its own token, id, scopes and host grants. Approval requires `approve:decide`, a host grant, and `approver != issuer`. | `src/control/clients.ts`, `src/control/engine.ts` |
| Typed operations `inspect / plan / validate / approve / execute / verify / status` | Single typed request union, validated against `schema/control-plane.schema.json` before dispatch. MCP exposes four tools only. `execute` is local-operator only. | `src/control/types.ts`, schema |
| Immutable fingerprinted plan | Plan snapshot (host, machine policy snapshot, argv, impact, classification) hashed with canonical JSON. Stored plan is re-hashed before approval and execution. Not cryptographically signed; see risks. | `src/control/canonical.ts`, `engine.ts` |
| Approval record with fingerprint, issuer, approver, expiry, single-use nonce | Stored in the operation record; nonce consumed atomically when execution starts; consumed nonces persisted. | `engine.ts`, `store.ts` |
| Changed plan, replay, different target never pass an old approval | Fingerprint re-computed against current inventory before execution; approval state checked; nonce set checked; host in fingerprint. | `engine.ts` |
| Durable append-only audit journal, tamper-evident | JSONL with SHA-256 hash chain (`prev` + `hash`), verify command, fail-closed on corruption, secret-material guard before append. | `src/control/journal.ts` |
| Never store secret values | Plans containing secret-like material are refused; argv is redacted before journaling; token digests only; journal refuses entries matching secret patterns. | `src/control/redact.ts` |
| Operation states `pending|approved|executing|succeeded|failed|unknown` | Exact six-state machine. Failed and unknown never re-executed. Interrupted `executing` recovered to `unknown` on init. | `engine.ts` |
| Token auth, token hashes at rest, constant-time compare, OIDC-ready | `ClientAuthenticator` interface; `TokenClientRegistry` implements it with SHA-256 digests and `timingSafeEqual`. | `clients.ts` |
| Loopback MCP over Streamable HTTP, JSON-RPC 2.0, `initialize`, `tools/list`, `tools/call` | Hand-written JSON-RPC handler on `Bun.serve` bound to `127.0.0.1`. Host and Origin checks. Bearer auth on every request. | `src/control/mcp.ts` |
| No raw shell, no Docker socket, no general root for MCP clients | MCP plans refuse `full` tier, shell/interpreter/privilege-wrapper commands, opaque classification, container runtime sockets, and non-inspection container/hypervisor control. | `engine.ts` (`screenPlan`) |
| Optional CLI entry points without changing existing commands | `homectl serve-mcp`, `homectl control client add|list|revoke`, `homectl control execute`, `homectl control audit verify`. New options are added to the parser; existing commands are untouched. | `src/control/cli.ts`, `src/cli/main.ts` (dispatch only) |

### 2.1 Decisions made for slice 1

1. **Approval is uniform.** Every control-plane plan needs an approval by a distinct client, even when the existing policy classifies argv as `inspect`. This is stricter than the CLI path (which runs inspection without a digest). Rationale: one rule for remote callers, simpler to audit.
2. **Read-only operations do not change operation, approval or client state.** They do append an audit entry (`request.accepted`). This is a deliberate reading of "never mutate": the audit journal is append-only by design. Reviewers may reject this reading; if so, reads can be made unaudited without touching the rest of the design.
3. **Execution is a local operator action** (`homectl control execute <operation-id>`), not an MCP tool. No client scope can grant it. The MCP surface matches the approved list: inspect, status, plan, approve.
4. **Plan TTL 15 min, approval TTL 5 min.** Expiry is evaluated at the moment of use. Records past expiry are closed as `failed` during the next mutating request. Read-only calls report `expired` but do not write.
5. **Outcome classification with spawn tracking.** The runner passed into the existing `execute()` is wrapped so the engine knows whether a process was spawned. Refusal before spawn becomes `failed` (nothing ran). Any throw after spawn, and any abnormal end, becomes `unknown`. A non-zero exit becomes `failed` with the exit code. Output is returned to the local operator only and never persisted.
6. **Inspect is metadata only.** `homectl_inspect` returns a redacted machine view (name, description, transport, access, enforcement, caution). It does not expose addresses, users, ports, key paths or SSH aliases, and it does not run commands.
7. **Host grants are explicit lists.** No wildcard grants. Denied and unknown hosts return the same message to avoid enumeration.
8. **No new npm dependency.** The MCP surface is four tools and three JSON-RPC methods (plus `ping` and notifications). Implementing it directly avoids adding a transitive dependency tree and an SDK transport model that this slice does not need. The lockfile is unchanged. Revisit when more of the MCP specification is required.

## 3. Compatibility plan

- **Existing CLI behavior unchanged.** `exec`, `ssh`, `peer`, `sync`, `pair`, `serve`, `session`, `key`, `enroll`, `provision` are not modified. `main.ts` gains option names (`--scopes`, `--hosts`, `--name`, `--token-file`) and one dispatch branch per new command. Existing tests must still pass with the same baseline failure set.
- **Inventory schema unchanged.** The control plane reads `inventory.yaml` through the existing `loadInventory`.
- **State location.** `control-plane/` beside the inventory (same pattern as `peers.json` and `serve/`), mode 0600 / owner-only ACL. Added to `.gitignore`.
- **Two approval systems coexist.** The in-memory peer hub queue remains as is. The control plane queue is durable and separate. Converging them is deferred to the peer/sync deliverable (3); slice 1 does not change the peer protocol or hub.
- **Schema additions only.** `schema/control-plane.schema.json` is new. No existing schema is changed.

## 4. Conflicts and divergences found (documented, not overridden)

| # | Existing design | Requirement | Slice 1 resolution |
| --- | --- | --- | --- |
| C1 | Inspect and mutation argv run without approval in the CLI and peer paths. | Typed approval for operations; "never execute without approval" for remote callers. | Control plane requires approval for all plans. CLI and peer behavior unchanged. Documented divergence. |
| C2 | `hash()` uses `JSON.stringify` (key-order dependent). | Stable fingerprint. | Control plane uses canonical (sorted-key) JSON for its own fingerprint. It also embeds the existing `execApproval` digest and recomputes it at execution, so it inherits the key-order dependence for that field. Risk R3. |
| C3 | `Hub.decideOperation` sets `state='done'` before executing and has no `unknown` state. | Failed/unknown recorded and never blindly replayed. | Not changed in the peer hub. Control plane implements the six-state machine separately. Risk R5. |
| C4 | `execute()` does not expose whether a process was spawned. | Correct `unknown` vs `failed`. | Wrap the runner; `operations.ts` is not modified. |
| C5 | Full-tier and root SSH are first-class in the CLI. | Privileged shell / general root not offered to normal MCP clients. | MCP plans refuse `full`. CLI unchanged. A future privileged client class needs its own ADR. |
| C6 | No audit log exists in the repository (grep for `audit` in `src`, `tests`, `docs` returned no matches). | Durable audit journal. | New `journal.ts`. |
| C7 | `privateDirectory`/`protect` spawn PowerShell on Windows per call. | Acceptable write cost on Windows. | Control plane calls them once at init; state writes rely on inherited directory ACL. |
| C8 | Baseline `bun test` has environment-dependent failures on this Windows checkout. | `bun run check` passes. | Not fixed here. Reported as pre-existing. |

## 5. Open risks and gaps (slice 1)

- **R1 — Same-user attacker.** Anyone who can write the state directory can rewrite `state.json`, `clients.json` or delete `audit.jsonl`. The hash chain detects in-place edits and mid-chain deletion but **not tail truncation**. Mitigation later: anchor the chain head outside the directory (for example, on the peer device) or sign with a key held elsewhere.
- **R2 — Plan integrity is fingerprinted, not signed.** Stored plans are re-hashed before use. A same-user attacker who rewrites both the plan and its fingerprint defeats it (see R1).
- **R3 — Key-order dependence in the existing digest.** Harmless for security (it causes false mismatches, not false matches) but fragile. Not changed.
- **R4 — Token theft.** A token file readable by another same-user process grants that client's scopes until revoked. Revocation is immediate (registry re-read on each request). Tokens are 256-bit random; they are never printed by `client add`.
- **R5 — Unknown-outcome handling is conservative.** A locked-session refusal that happens after the runner spawned the worker is classified `unknown` even though the remote command likely did not run. Operators must inspect; nothing is retried.
- **R6 — Output is not persisted.** Local `execute` prints stdout/stderr to the operator; MCP clients see only state and exit code. Consequence: remote clients cannot read command results in slice 1.
- **R7 — Secret detection is pattern-based.** Refuses obvious forms (PEM headers, `password=`, `token:`, `Bearer ...`, `hct_` tokens). It does not prove absence of secrets. Impact text and argv are both screened.
- **R8 — Unauthenticated probes are journaled.** Failed auth attempts append `auth.rejected` entries without a client id. No rate limiting in slice 1; a local process could grow the journal. Mitigation later.
- **R9 — Windows lock semantics.** The state lock uses exclusive-create lock files with a 30 s staleness rule. Adequate for the single-host, low-concurrency use here; not a formal lock. Not verified on Windows beyond unit tests that run on this machine.
- **R10 — Loopback HTTP only.** The MCP endpoint is plain HTTP on `127.0.0.1`. Non-loopback binding is refused in code. No TLS. Remote access would need a separate design (issue #5 and Authentik work).
- **R11 — Growth.** Operations, idempotency entries, consumed nonces and the journal grow without retention in slice 1. Each mutating request reads the whole journal to find the chain head; acceptable at homelab volume, needs a tail-read optimization later.
- **R12 — Proxmox LXC is not supported.** `pct` is only blocked for MCP unless inspection. No LXC lifecycle adapter exists or is claimed.

## 6. Suggested next slices

1. Peer deliverable (3): converge the in-memory peer queue onto the durable control-plane operation model, or keep both with an explicit ADR. Include chain-head anchoring (R1).
2. Authentik OIDC: implement an authenticator behind `ClientAuthenticator` (the interface is in slice 1); map groups to scopes and host grants.
3. Output channel for approved executions (bounded, redacted, stored as digests or to the operator only) if remote clients need results.
4. Proxmox lifecycle adapters (deliverable 4) and Ugreen onboarding (deliverable 5) as separate scoped slices.
