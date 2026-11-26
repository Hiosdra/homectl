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
- [Limitations](#limitations)

## Trust boundaries

Three parties matter: the **owner** (you), the **broker** (`home-ctl daemon run`), and **agents** (Codex, Claude Code or another MCP client). Agents are not trusted with keys, the vault password or approvals.

| Surface                           | Who calls it                                          | Authentication                                                        |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `/v1/*` (agent routes) and `/mcp` | An agent, through `home-ctl mcp` or the HTTP endpoint | `Authorization: Bearer <client token>`                                |
| `/v1/owner/*`                     | You, through the owner panel or CLI                   | Owner session: panel cookie or `Owner <token>` from `/v1/owner/login` |

Enforced in the broker (`src/broker/server.ts`):

- Owner tokens are never accepted on agent routes, and client tokens are never accepted on owner routes.
- Panel sign-in sets an `HttpOnly`, `SameSite=Strict` cookie scoped to `/v1/owner`, valid for 15 minutes. The cookie also carries `Secure` when the panel origin is `https`. Cookie-authenticated owner requests must come from an allowed origin (the panel's `HOMECTL_PANEL_ORIGIN`).
- Five failed owner sign-ins lock sign-in for 60 seconds.

**Where the panel listens.** The owner panel (`daemon panel`, `src/web/owner/`) listens on `127.0.0.1` by default. `HOMECTL_PANEL_LISTEN=<IP address>` moves it to another address. Then `HOMECTL_PANEL_ORIGIN` must name the exact browser origin, and the broker must be started with that same origin. The Host and Origin checks stay as strict on every address. Anything that can route to a non-loopback address can open the sign-in page, so keep it behind a firewall that admits only your LAN or VPN, or behind a reverse proxy you run.

**Plain http is refused by default.** A non-loopback panel whose origin is `http://` does not start unless `HOMECTL_PANEL_INSECURE_HTTP=1` is also set. Without `https`, the owner password and the session cookie cross the LAN in clear text, and the cookie is not `Secure`. Use one of the supported ways instead:

- an `https` reverse proxy you run, with `HOMECTL_PANEL_ORIGIN` set to the `https` origin users open; or
- an SSH tunnel to loopback, with the panel left on `127.0.0.1`.

The opt-in is for a network you trust. The panel prints a warning when it starts this way. The refusal is made by the panel process; the broker accepts the origin it was started with.

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

| Panel label                                      | Preset         | Mode    | Reviewer authority              |
| ------------------------------------------------ | -------------- | ------- | ------------------------------- |
| "Ask me first" (used when no policy file exists) | `conservative` | `rules` | `recommend` (the owner decides) |
| "AI helps with small fixes"                      | `routine`      | `auto`  | `routine`                       |
| "AI decides more"                                | `delegated`    | `auto`  | `delegated`                     |

Until 0.3.0 the "AI helps with small fixes" preset used `rules` mode, so the AI helper was never consulted. It now uses `auto`, so the helper is consulted for requests no rule covers, but only once an AI helper is configured (`reviewer.provider`); without one, requests still wait for you.

The hard gates apply under every preset and never reach the helper: R4 and human-only actions always wait for you, and R3 needs an owner rule that covers it. Routine authority allows only R1–R2 inspection or change; delegated authority still never allows above R2 on the helper's word. The step-up rules are unchanged.

Changing a preset or removing a rule needs your owner password in the same request. The policy file is `policy.json` in the broker state directory, and only the broker writes it.

### Auto Mode and the reviewer

Auto Mode (`mode: auto`) lets a reviewer decide requests that no owner rule covers. The reviewer is off until you set it up. The conservative preset uses `rules` mode, and the reviewer is never called in `manual` or `rules` mode.

Settings:

| Setting                      | Where                                                                                                                                               | Values                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Mode                         | `policy.json`, `mode`                                                                                                                               | `manual`, `rules` (default), `auto`                                                                                              |
| Reviewer authority           | `policy.json`, `reviewer.authority`                                                                                                                 | `recommend` (default), `routine`, `delegated`                                                                                    |
| Provider, endpoint and model | `reviewer.json` in the broker state directory (0600)                                                                                                | Provider `anthropic`, `openai`, `openrouter` or `custom`; `https` URL, or plain `http` on loopback for Custom; a model name      |
| API key                      | One entry in the encrypted vault (`homectl/reviewer-api-key`, group `homectl/api`), or the daemon's `HOMECTL_REVIEWER_API_KEY` environment variable | Never returned by any API, never logged, never shown again. The environment variable takes precedence at its configured endpoint |

**Where the AI helper's key lives (0.3).** The key is kept in the encrypted KeePassXC vault (`homelab.kdbx`) as one entry, `homectl/reviewer-api-key`. You can save it in the panel under "Connect your AI helper" or privately with `home-ctl owner auto-mode set-key`, which prompts for the key and never takes it as an argument. Saving, replacing and forgetting the key need your owner password. The broker reads the key only when it calls the provider. Set the endpoint before using the CLI to save a key. The broker binds the saved key to that exact address, including its path. If `HOMECTL_REVIEWER_API_KEY` is set, it takes precedence at the original configured endpoint. For a different address, enter a key for that address in the panel or use a server that accepts requests without a key. If the vault is locked, the helper does not run: the panel says "Unlock homectl to use the AI helper", and every request waits for you.

Replacing a key keeps the old value in the entry's history inside the encrypted vault. "Forget key" removes the entry and its history.

**Threat note.** Anyone who knows the vault master password can read the AI helper key, as they can read the other secrets in the vault. The key is not protected from a process that already runs as the broker user while the vault is open. The owner password is the only gate; treat it like the other vault secrets.

The routes that list models and run the test take a key only from the request during onboarding, before it is saved. Afterwards they use the environment or the vault. The browser never calls a provider; the broker does, so the key never goes to the browser.

`home-ctl owner init` asks for the reviewer authority after you set the owner password. Enter keeps `recommend`. Without a terminal, `recommend` is kept. Change it later with `home-ctl owner auto-mode set --authority <value>`, or with the `/v1/owner/auto-mode/set` route.

**Authority.** The authority only matters once Auto mode and an endpoint are set.

- `recommend` (default): the reviewer's verdict is recorded but never acted on. You decide every request that reaches the reviewer.
- `routine`: a reviewer `allow` is honoured for routine requests at R2 or below (inspection or change, never destructive or opaque, never with sudo).
- `delegated`: a reviewer `allow` is honoured for any request at R2 or below. This is the wider scope, and it still stops at R2.

A reviewer `deny` denies the request, and a reviewer `ask` asks you, whatever the authority. R3, R4 and human-only kinds never reach the reviewer. The hard gates answer them first, so they always need you.

**Order.** The reviewer is asked only after the invariants, hard gates, task scope, budgets and owner rules have made no decision. A request that an owner rule resolves makes zero model calls. The decision records how many model calls it made.

**A verdict is not an approval.** A reviewer `allow` dispatches the operation with `source: reviewer`. No owner approval is recorded (`approvedBy` stays empty), and the audit event `operation.updated` carries the decision source, verdict and model call count. The reviewer's own reason text is model output and is not stored in the operation record.

**What the reviewer sees.** Only the kind, risk, host, argv, classification, sudo flag, resource and the requester's narrative, which is marked untrusted and cut to 1000 characters. It does not see the client identity, the task text, the parameters or the policy.

**Failure.** A timeout (8 seconds), a network error, a non-OK status, a redirect, or output that is not exactly `{verdict, reason, suggestion?}` is treated as no answer. The policy's `reviewer.fallback` then applies: `ask` by default, or `deny`. A broken reviewer configuration (for example an unreadable `reviewer.json`) also asks the owner.

**Step-up.** A change needs the owner password in the same request when it raises the reviewer authority, turns Auto Mode on, or sends the reviewer to a new endpoint. Lowering the authority, clearing the endpoint, and changing only the model name do not need it. Auto mode needs both an endpoint and a model. Every saved change emits `settings.updated` for the owner only, with the endpoint origin and never its path.

**Limits (not verified against a live model provider).** The adapters are tested against local fakes, covering allow, malformed, slow, key-header and status-error cases. The Anthropic Messages and OpenAI-compatible request shapes are checked against their documented formats; neither has been run against a live provider in this repository, and the browser checks use a loopback stub. The provider's model list and prices are shown as the provider sends them. The reviewer is called with the broker's state lock released: the operation waits as "under review", the owner can decide it meanwhile (the owner's decision wins), and the verdict is committed only if the operation, policy revision and budgets did not change. The owner panel has a "Let an AI helper decide (advanced)" section under Permissions (`src/web/owner/auto-mode.tsx`). It shows how requests are decided (the mode) and what the AI helper may decide (the reviewer's authority); the helper's address (endpoint), model name and key status sit under "Advanced". It changes them through `/v1/owner/auto-mode/get` and `/v1/owner/auto-mode/set`, the same routes as `home-ctl owner auto-mode`. It asks for the owner password only when the broker says the change needs it. The hardened `daemon install` asks for the authority when it sets a new owner password; on the custody-vault path it keeps `recommend`.

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

Retention is `ephemeral` (the value lives for 1 hour in memory) or `saved` (stored under `homectl/secrets/requests` in the vault). Each save creates a separate entry with the name you choose and a unique suffix. The request reference is valid only in the current broker process. If you explicitly allow reuse when saving, the same assistant may request a new reference for the same task, exact destination, inventory target and field types after the broker restarts. Review and revoke these grants under **Saved secret reuse** in **System**. Revocation invalidates the live references and preserves the encrypted value in the vault. A locked vault refuses delivery. The broker refuses a secret request for a host the client may not use, with the same error exec gives, so a client cannot probe which hosts exist.

Providing a value (`/v1/owner/secrets/provide`) is a step-up route: the owner password must be sent in the same request, and an owner session alone is refused before anything is stored. The panel must send the password too.

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

### 2a. Adding a machine in the owner panel

The panel's Machines section does the same steps as the CLI, in one guided sheet. The trust rules are the same, and each step is checked by the broker, not only by the page:

1. **Key.** The panel waits for `home-ctl key create <name>`, which you run in your private terminal. The panel reads only the public key. It never sees or stores the private key.
2. **Install.** The panel shows what to put in the machine's keys file for Linux, UGOS and Proxmox. You install it with access you already have. The panel does not log in anywhere.
3. **Identity.** A scan shows the keys the address presents, labelled **not verified**. You compare the fingerprint with the machine's own console or provider page, and type it. Only an exact match moves on. A scanned key is never pinned automatically.
4. **Enrol.** Your owner password is asked again. The broker re-scans, pins only the typed fingerprint, writes the inventory, and runs the same check as `home-ctl enroll`. If that check fails, the pin is taken back, so nothing stays trusted for a machine that is not on your list.

Other changes to a machine need the owner password every time:

- **Check again** runs one read-only command through the machine's key.
- **Change access level** is a trust change, so it always asks. `root` is always Full admin and cannot be lowered in the panel.
- **Remove machine** drops the inventory entry, the assistants' access to it, its pinned key and its check record. It does not delete the vault key, the public key on the machine, or anything on the machine itself. Those stay until you remove them yourself.

Routes and their bodies are in [reference](reference.md#machine-routes-owner-03).

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

Workspace clients run these backups (see [workspace](workspace.md#incremental-encrypted-backups)). A reset client is restored with `workspace restore`, which also revokes the old client identity; see [workspace](workspace.md#restore). A live restore between two machines has not been verified yet.

### Backup server compromise (D6A)

**The backup server can decrypt every client backup it holds.** Anyone who gets the server's custody key (`workspace-server.json`) and its backup store (`workspace-backups`) can open all of them. The owner authorization and verification checks above are the server's own software, so a compromised server does not have to pass them. Treat the server's state directory as the most sensitive data in a workspace, and keep off-server copies as described in [lost server](workspace.md#lost-server).

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
- **Backup server compromise.** Anyone holding the server's custody key and backup store can decrypt client backups. See [backup server compromise](#backup-server-compromise-d6a).

## Limitations

- **A passing test suite is not a security guarantee.** Most tests run against fakes: a fake remote host, a loopback reviewer, a fake executor, and stubbed workspace and update routes in the browser checks. They show that the checked behaviour holds under those conditions, and nothing more.
- **Not verified live:**
  - the compiled executable on the Windows PC (CI runs the compiled Windows executable on a Windows runner, not on that PC);
  - the container image on the Ugreen NAS (CI runs it on Linux runners only);
  - a workspace across two real machines, including pairing and restore (in-process tests only);
  - a real model reviewer (the tests use a loopback fake and make no provider call);
  - migration from a real 0.2 install (fixture data only).
