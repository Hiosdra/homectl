---
name: homelab-setup
description: Bootstrap and diagnose homectl on the current agent host, including portable Codex/Claude skills, SSH configuration and private KeePassXC session setup.
---

## Communication

Apply this skill without routinely quoting its paragraphs, listing rule numbers or explaining each action by reference to the skill. Report actions, results and relevant limitations in plain language. Mention skill use once when required by the host's instructions. If a skill rule actually requires approval or blocks progress, briefly identify the skill and the specific reason once at that decision; do not repeat it in later updates unless the situation changes. Explain rules in more detail only when the user asks. This changes communication, not authorization or safety requirements.

1. Read repository README and docs/architecture.md. Inspect OS, Bun 1.4.2+, OpenSSH, Bash and KeePassXC CLI. Keep the checkout at a stable path; run `bun install --frozen-lockfile`. Use documented OS packages and official Bun installation when missing.
2. Review `bun src/cli/main.ts setup --dry-run`, then setup when authorized. It creates per-user configuration, a CLI launcher, SSH Include and three skill links for Codex/Claude. Preserve conflicting user files; setup refuses replacements. Ensure `~/.local/bin` is on PATH.
3. Inspect existing inventory/session configuration. Use `homectl session configure --ttl <duration>` only for a requested change: it locks the current session. Default is 24h; durations range 1s–365d or until-reboot. TTL is absolute, never sliding. Cold reboot loses keys; suspend/snapshots are different.
4. For a new database, have the user run `homectl session init` privately. Never initialize over an existing KDBX. Strong password and encrypted backups are the user's responsibility. Never prompt for passwords via agent-visible tools or chat.
5. For new hosts, follow homelab-enroll: user-run `key create`, public-key installation through trusted access, then enrollment. KeePassXC stores each private key as the entry's id_ed25519 attachment. Only public references enter inventory. Automatic generation requires Linux tmpfs; see README for manual macOS preparation.
6. For configured hosts, check `homectl session status --json`; ask for private `session unlock` only when locked. Routine SSH and Proxmox use the same managed key session. Initialization/key editing require private password entry even if SSH is already unlocked. Do not export attachments or inspect private keys.
7. Run `homectl doctor --json`, then named host checks when requested. Verify SSH fingerprints through a trusted console before enrollment. A root/full host skips sudo checks; non-root full checks sudo -n true. Limited sudo diagnostics never restart services.
8. Report missing tools, session state, verified connectivity and actionable next steps. Keep static checks, real SSH proof and real VM provisioning evidence distinct. Setup does not deploy agents to ordinary machines.

Run lifecycle/database/inventory operations sequentially and close GUI database editing during CLI writes. Lock affects only the dedicated agent. Do not remove recovery credentials, old server keys, backups, personal vault software or broader sudo grants implicitly. Automatic key generation cleans only its own staging artifacts. Human prompts are accepted workflow protection, not hard isolation.

Ask required choices/approvals visibly in chat with concrete scope. Keep passwords/session values out of transcripts, shell history and startup files. See README for private initialization, daily use, recovery and storage limitations.
