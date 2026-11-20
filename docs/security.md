# Security model

This page describes what homectl 0.3.0 enforces, what it only advises, and what remains your responsibility. Setup steps are in [setup](setup.md); command syntax is in [reference](reference.md).

## Contents

- [Trust boundaries](#trust-boundaries)
- [Vault and secret custody](#vault-and-secret-custody)
- [Approvals and Auto Mode](#approvals-and-auto-mode)
- [Secret requests](#secret-requests)
- [Host enrollment](#host-enrollment)
- [Host access tiers](#host-access-tiers)
- [Backup custody](#backup-custody)
- [Residual risks](#residual-risks)

## Trust boundaries

Three parties matter: the **owner** (you), the **broker** (`home-ctl daemon run`), and **agents** (Codex, Claude Code or another MCP client). Agents are not trusted with keys, the vault password or approvals.

| Surface                           | Who calls it                                          | Authentication                                                        |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `/v1/*` (agent routes) and `/mcp` | An agent, through `home-ctl mcp` or the HTTP endpoint | `Authorization: Bearer <client token>`                                |
| `/v1/owner/*`                     | You, through the owner panel or CLI                   | Owner session: panel cookie or `Owner <token>` from `/v1/owner/login` |

Enforced in the broker (`src/broker/server.ts`):

- Owner tokens are never accepted on agent routes, and client tokens are never accepted on owner routes.
- Panel sign-in sets an `HttpOnly`, `SameSite=Strict` cookie scoped to `/v1/owner`, valid for 15 minutes. Cookie-authenticated owner requests must come from an allowed origin (the panel's `HOMECTL_PANEL_ORIGIN`).
- Five failed owner sign-ins lock sign-in for 60 seconds.
- Request bodies are limited to 64 KiB.
- Agents only see events addressed to them. The owner sees all events.

Each agent install gets its own client identity and token. `home-ctl agent connect` creates the client, shows the exact config change, and applies it only after you confirm. The token goes into that agent's configuration file, and into the private client-token file that `home-ctl mcp` reads.

### Two broker modes

| Mode                                             | Where it runs                                                                                                      | What separates it from you                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hardened** (Linux with systemd only)           | A `homectl` system account, state in `/var/lib/homectl` (mode 0700), installed with `sudo home-ctl daemon install` | The agent's OS user cannot read broker state, keys or the vault. Agents reach the socket `/run/homectl/agent.sock`, which is world-writable (mode 0666), so the client token is the only check. |
| **Compatibility** (`--mode compat`, the default) | Your OS user, state under `<inventory directory>/broker`                                                           | **Weaker.** Any process running as your user can read the broker state and use the unlocked SSH agent. `home-ctl daemon status` says so.                                                        |

Hardened mode is not available on Windows or macOS in this build; `daemon install` refuses there and says to use compatibility mode. Hardened mode also needs systemd, so it is not available in WSL without systemd enabled or in containers.

<!-- verify: hardened socket permissions and "agent's user cannot read state" come from src/cli/daemon-command.ts and src/broker/install.ts comments; not tested here on a Linux host. -->

## Vault and secret custody

**Vault.** The broker keeps an encrypted KeePass database (`homelab.kdbx`). In compatibility mode it is at the database path from `session configure` (default: next to the inventory). Hardened mode copies the workspace into broker custody and keeps the vault there.

**Owner password.**

- When a vault exists, its master password is the owner password. `home-ctl owner init` refuses to set a separate one.
- With no vault, `home-ctl owner init` sets a separate owner password, stored as an argon2id verifier.

**Keys.** Each machine has one Ed25519 key, stored as an attachment in the vault. Unlocking loads the keys into a dedicated OpenSSH agent. The agent holds keys, not the database password.

**Timers.**

| Timer                | Default                              | Effect                                                                                        |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Absolute session TTL | 24 hours (`session configure --ttl`) | Locks the vault and clears keys                                                               |
| Idle lock            | 1 hour                               | Locks after no activity                                                                       |
| Privileged window    | 10 minutes                           | Admin-tagged keys load only after you re-enter the owner password (`/v1/owner/vault/elevate`) |

Locking clears the SSH agent's keys, drops in-memory secrets, ends owner sessions, cancels queued approvals and stops new dispatch. Connections that are already open can finish. Locking never touches your personal SSH agent.

<!-- verify: key storage as an attachment and the agent holding no database password are carried from the 0.2 credential model (src/session/keys.ts); not re-tested here. -->

## Approvals and Auto Mode

Every request from an agent passes a fixed decision pipeline (`src/authz/evaluate.ts`). The first step that resolves the request wins:

1. **Invariants.** Unknown clients or hosts, empty argv, and control characters in argv are denied.
2. **Hard gates.** Human-only kinds always ask the owner. R4 always asks the owner. R3 asks the owner unless an owner allow rule covers exactly R3 (R4 is never covered).
3. **Task scope.** An expired or closed task is denied. A request outside a task's delegated scope asks the owner.
4. **Budgets.** Requests at R2 or above count against budgets. Exceeding one asks the owner.
5. **Owner rules.** Deny beats ask, and ask beats allow.
6. **Mode.** In `manual` and `rules` modes, an unmatched request asks the owner.
7. **Reviewer.** Auto mode only. See the note below.
8. **Default.** Ask the owner.

### Risk levels and budgets

| Risk | Points | Meaning                                          |
| ---- | ------ | ------------------------------------------------ |
| R0   | 0      | Metadata reads                                   |
| R1   | 1      | Safe inspection                                  |
| R2   | 3      | Routine, reversible change                       |
| R3   | 10     | Significant, opaque or privileged                |
| R4   | 30     | Destructive, trust-changing or credential export |

Defaults in the policy file (`budgets`):

- Per task: 50 operations and 60 risk points.
- Per client: 120 risk points in a rolling 1-hour window.

R0 and R1 do not count, so a long read-only session does not start prompting.

### Built-in rule and presets

The one built-in rule allows read-only `exec` (classified as inspection, up to R1, never with sudo) on any host, for any client. Safe reads such as `uname -s` therefore run without a prompt.

Presets set only the mode and reviewer authority. Rules and budgets stay as they are.

| Preset                                           | Mode    | Reviewer authority              |
| ------------------------------------------------ | ------- | ------------------------------- |
| `conservative` (used when no policy file exists) | `rules` | `recommend` (the owner decides) |
| `routine`                                        | `rules` | `routine`                       |
| `delegated`                                      | `auto`  | `delegated`                     |

Changing a preset or removing a rule needs your owner password in the same request. The policy file is `policy.json` in the broker state directory, and only the broker writes it.

### Auto Mode and the reviewer

Auto Mode (`mode: auto`) lets a reviewer decide requests that no rule covers. The reviewer adapter (`src/authz/http-reviewer.ts`) sends only the kind, risk, host, argv, classification, sudo flag, resource and the untrusted requester narrative. It requires an `https` endpoint, or plain `http` on loopback.

Even when a reviewer allows something, `delegated` authority never allows above R2. R3 and R4 always reach you.

<!-- verify: the daemon currently constructs AuthzPolicy without a reviewer (src/broker/daemon.ts); httpReviewer() is defined but not called from the daemon. In this build, Auto Mode therefore asks the owner for requests no rule covers. Confirm before relying on the reviewer. -->

### Owner decisions

The owner decides with `home-ctl approve <operation>`, `home-ctl deny <operation>`, or the owner panel. `--remember` saves an exact rule from that one request.

- A decision is bound to the operation's fingerprint. If the host's inventory entry changed since the plan was made, the operation fails with `plan-changed`.
- A plan expires 15 minutes after it is made.
- R3 and above, and all human-only kinds, need **step-up**: the owner password is checked again for that one decision. The CLI always sends it.
- `approve --remember` saves an allow rule only for an exact request. Human-only kinds and R4 requests are refused, and an allow rule needs an exact host and exact argv. The rule matches the same client, host, kind, argv (complete match, so a longer command does not match), risk and sudo flag. It is never a wildcard. `deny --remember` saves a deny rule for the same exact match.

### Tasks

`home-ctl task open "<title>" [--ttl MINUTES]` opens a task, which groups operations under one budget. The default lifetime is 4 hours; the limits are 1 minute to 24 hours. A closed or expired task denies new operations. `task close <id>` ends it early.

### Local `exec` and the removed `--approval` flag

`--approval <digest>` was removed in 0.3.0. Any command that contains it is refused with a message that points to the broker. Without a running broker, `home-ctl exec` still refuses any command that needs approval (exit code 4) and tells you to run it through the broker.

## Secret requests

Agents must not ask for passwords in chat. They ask the broker for a secret instead.

1. The agent calls the `secret_request` MCP tool (or `POST /v1/secret/request`) with a purpose, a **destination**, and up to 10 fields. The request expires after 15 minutes by default (minimum 1 minute), and each client may have at most 32 pending requests.
2. You provide the value in the owner panel's secret screen. The panel shows the exact destination before you provide it. Providing it is the approval for that one use path.
3. The agent calls `secret_use` (`POST /v1/secret/use`). The broker injects the value itself and redacts it from any output it returns.

Destination kinds:

| Kind          | Where the value goes                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `ssh-stdin`   | Standard input of a fixed argv on an inventory host                                     |
| `target-file` | A file on an inventory host, written with its final mode                                |
| `http-header` | One HTTPS request header                                                                |
| `vault-only`  | Kept in the vault. The broker has no injection plan for it, so `secret_use` refuses it. |

Retention is `ephemeral` (the value lives for 1 hour in memory) or `saved` (stored in the vault under a name you choose). The broker refuses a secret request for a host the client may not use, with the same error exec gives, so a client cannot probe which hosts exist.

<!-- verify: the owner secret provide route (/v1/owner/secrets/provide) does not check a fresh owner password in this build (src/broker/secret-service.ts); it requires an owner session only. -->

The agent never receives the value. A raw hand-off to the agent is a human-only kind and is not part of the agent's tools.

## Host enrollment

Adding a machine is a trust decision. homectl does three things separately: it records the machine, pins its host key, and optionally grants sudo.

### 1. Verify the host and install the key

1. Verify the host's SSH fingerprint through the machine's console or provider panel. A scan alone proves nothing.
2. Create the machine's key with `home-ctl key create <name>` and install only the public key, through access you already have.
3. Enroll the machine with `home-ctl enroll <name> --file <host.json> --dry-run`, then without `--dry-run`. Enrollment checks SSH and the operating system, then saves the inventory entry. It does not set passwords or change existing accounts.

### 2. Owner-verified host key pinning

The broker can pin a host key. Each step needs your owner password:

- `home-ctl owner scan-host-keys <host>` shows the keys the network presented. A scan is **never trusted** by itself.
- `home-ctl owner pin-host-key <host> <SHA256:…>` pins only the key whose fingerprint you typed, after you compared it out of band. It refuses if no presented key matches, if the key is listed as `@revoked`, or if a different key is already pinned for that address. Replacing a pinned key is a separate, manual decision.

Pins are written to the `known_hosts` file next to the inventory.

### 3. Agentless sudo grants (sudoers drop-ins)

A grant gives a homectl-managed account sudo rules through one file. Every step needs your owner password, and host permissions exist only when a vault is present:

- `home-ctl owner inspect-host <host>` reads the host's current state.
- `home-ctl owner preview-host-grant <host>` builds the grant and returns its fingerprint. Nothing changes.
- `home-ctl owner apply-host-grant <host> <fingerprint>` applies exactly the grant you reviewed. It refuses if the grant changed since the preview.
- `home-ctl owner revoke-host-grant <host>` removes homectl's own drop-in.

The code only ever writes `/etc/sudoers.d/homectl-<user>`:

- A file must carry a homectl header (`# homectl-managed id=… sha256=…`). Files without that header are never edited.
- Apply writes a temporary file, checks it with `visudo -cf`, backs up the live file, renames the new file into place, then checks the installed file's hash and that `sudo -l` works. Any failure restores the backup.
- Revoke backs up the drop-in, removes it, checks `visudo -c`, and restores the backup if that check fails.

Dot-named temporary and backup files are ignored by sudo's `includedir`, so leftovers stay inert.

<!-- verify: `home-ctl enroll ... --configure-sudo` is the 0.2 path that installs literal sudo rules directly; check which path 0.3.0 actually uses before documenting it as the recommended one. -->

## Host access tiers

Each machine has one tier in the inventory. Tiers say what the agent is intended to run. They do not create privileges: real privileges still come from your accounts and system configuration.

| Tier            | Intended use                                              |
| --------------- | --------------------------------------------------------- |
| `observe`       | Recognized, read-only inspection                          |
| `user`          | The existing account, no privileged commands              |
| `sudo-approved` | Exact absolute commands listed in `sudo_allow` (required) |
| `full`          | Arbitrary commands, subject to review                     |

A root SSH account must use `full`. Passwords never enter agent chat.

## Backup custody

Backups are encrypted on the client before upload. The server stores ciphertext, and it can decrypt client backups because it holds the wrapped client keys under its own custody key. This is a deliberate trade-off (the design's "D6A"):

- The server never decrypts during a normal commit. It checks the chain and that every referenced chunk exists.
- Unwrapping a client key and restoring a snapshot each require an **owner authorization**: an owner action, a fresh owner password (step-up) and a stated reason. Both are human-only actions in the approval model.
- A restore refuses to return data unless the whole snapshot verifies.

Server custody and the cryptography are described in [workspace](workspace.md#incremental-encrypted-backups).

Workspace clients run these backups (see [workspace](workspace.md#incremental-encrypted-backups)). Restore of a reset client is not implemented yet.

## Residual risks

- **Confirmation is a safeguard, not a sandbox.** An approved command runs with the privileges its account already has.
- **Rules run without asking.** An allow rule, a remembered rule and the built-in read-only rule run matching commands with no prompt. Review the rule list in the panel's policy screen.
- **Compatibility mode shares your user.** Any program running as you can read the broker state and use the unlocked SSH agent. Use hardened mode on Linux with systemd when you can. Lock the session when you finish.
- **Hardened sockets are world-writable.** Any local account can connect to the agent socket and try a client token. The token is the only check.
- **One password, two roles.** When a vault exists, the owner password is also the vault master password. Losing one exposes the other.
- **Redaction is pattern-based.** Output redaction catches common secret forms (`--password=…`, `Authorization:` headers, URL passwords and similar), but it cannot recognise every way a secret can appear, such as inside a shell string. Pass secrets through secret requests, not argv.
- **Host keys are only as good as your verification.** A pin is only as trustworthy as the out-of-band fingerprint you compared.
- **Memory.** Keys and the database password pass through the CLI's memory during unlock. Clearing buffers is best effort. Swap, hibernation files, VM snapshots, root access and hypervisor access can expose them.
- **Untested platforms.** The Windows and macOS runtime, Windows named pipes and ACLs, and WSL networking are not verified on real hardware yet. See [setup](setup.md#verification-status).
