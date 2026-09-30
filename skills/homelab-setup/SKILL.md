---
name: homelab-setup
description: Bootstrap and diagnose the agentic-homelab CLI and portable Codex/Claude skills on the current agent host. Use for first installation, SSH configuration or Bitwarden backend setup.
---

1. Read the repository README and docs/architecture.md. Detect OS, existing Bun/OpenSSH and Bitwarden components. Keep the checkout at a stable path; execute `bun install --frozen-lockfile` inside it. Install Bun from its official source if missing.
2. Preview `bun src/cli/main.ts setup --dry-run --json`, then run setup when requested. It creates local inventory, a CLI launcher, SSH Include and links the same canonical skills in `~/.agents/skills` and `~/.claude/skills`. It refuses conflicting skill/launcher paths. Add `~/.local/bin` to PATH through an additive change. Do not reset an existing shell/SSH config.
3. Configure local inventory according to the user's selected access tiers. A local entry uses `transport: local`; a non-full local account must actually be non-root. Use the current existing account, not a mandatory agent account.
4. For desktop keys, enable Bitwarden SSH Agent and configure SSH_AUTH_SOCK or the inventory socket path. Desktop authorization/unlock may require GUI access. For headless key access, select local-ssh-agent. For password-only SSH or Proxmox tokens, use the researched early-preview `aac run` backend and a vault item ID reference.
5. Install Bitwarden CLI with setup's `--install-bitwarden-cli` if needed. AAC installation requires a pinned release and independently verified archive digest: `--aac-version <release> --aac-sha256 <hash>`. If no verified digest is available, guide the user through official installation; never invent one. Do not fetch arbitrary latest binaries into execution.
6. Let the user run `aac listen`/unlock/pair in a private trusted terminal. Pairing tokens, master passwords and session values must not enter the agent transcript, argv examples with actual secrets, repository or inventory. Check local `aac run --help` compatibility. Do not promise unattended provider approval or guaranteed caching durations.
7. Run `homectl doctor --json` and doctor each configured host. Verify authentication via connectivity probes, never secret dumps. Verify host-key fingerprints through a trusted channel and populate known_hosts on initial access; do not disable verification.
8. Report missing tools, pairing, host trust, sudo configuration and actionable remediation. Setup never deploys additional Codex/Claude agents to ordinary hosts.

Destructive changes, including replacing existing configurations/links, require exact explicit human confirmation even on full. A native prompt displaying the exact operation counts once. Privileged non-destructive setup uses the normal coding agent approvals. Do not weaken an explicitly selected full tier. Advisory inventory rules are not Unix isolation.
