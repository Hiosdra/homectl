# Integration research — 2026-09-30

Primary sources inspected before implementation:

| Integration | Official source | Decision |
|---|---|---|
| Bitwarden Agent Access | https://github.com/bitwarden/agent-access | Use documented AAC run field injection; early preview, not a stable Node SDK contract |
| Bitwarden SSH Agent | https://bitwarden.com/help/ssh-agent/ | Desktop keys through OpenSSH socket; do not portray desktop Linux support as bw-only headless support |
| Codex skills | https://developers.openai.com/codex/skills/ → https://learn.chatgpt.com/docs/build-skills | Portable SKILL.md and ~/.agents/skills |
| Claude Code skills | https://code.claude.com/docs/en/skills | Same source linked in ~/.claude/skills |
| Proxmox API | https://pve.proxmox.com/pve-docs/api-viewer/index.html | Focused clone/config/resize/start provider, injected API token |
| Proxmox cloud-init | https://pve.proxmox.com/wiki/Cloud-Init_Support | Require prepared template; explicit network/template user and public key |

The Bitwarden guide explicitly shows field-to-environment mappings with `aac run`. It also describes the provider's listen/unlock and pairing flow. homectl does not store additional credentials or implement its own cache/approval service. Consult the installed release's help and provider for pairing persistence, cache expiry and credential authorization; these are not stable assumptions in this project. No real Bitwarden account was used in tests.

The official Proxmox hosts did not return readable documentation through this environment's research/network fetcher. Attempts against the official documentation and source host failed. This is a research limitation, not a claim of endpoint or live-machine validation. The provider and fake tests are implemented, but first-use node API validation remains a tracked integration task. Do not present a successful fake test as evidence of a working production template or ACL set.

The user-facing design is deliberately permissive on full hosts. Machine accounts/OS privilege configuration and the coding agent's own approvals carry the system-level responsibility. The homectl approval digest binds an operation but cannot independently identify a human.
