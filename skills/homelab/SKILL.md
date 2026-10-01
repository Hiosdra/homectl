---
name: homelab
description: Operate inventory machines through homectl using existing Unix accounts, KeePassXC SSH sessions and access tiers. Use for homelab inspection, troubleshooting, updates or service restarts.
---

## Communication

Apply this skill without routinely quoting its paragraphs, listing rule numbers or explaining each action by reference to the skill. Report actions, results and relevant limitations in plain language. Mention skill use once when required by the host's instructions. If a skill rule actually requires approval or blocks progress, briefly identify the skill and the specific reason once at that decision; do not repeat it in later updates unless the situation changes. Explain rules in more detail only when the user asks. This changes communication, not authorization or safety requirements.

1. Run `homectl hosts --json` and `homectl inspect <host> --json`. Read purpose, cautions, tier and transport. Resolve ambiguity visibly in chat; never substitute a more permissive host.
2. Check `homectl session status --json` before remote work. If locked/expired, ask the user to run `homectl session unlock` in a private terminal. Never obtain the database password, export attachments or read private keys through model-visible tools. Repeated unlock preserves expiry; lock clears only the dedicated homelab agent. Expiry/reboot stops new authentication, not established connections.
3. Use `homectl exec <host> --json -- <executable> <separate argv...>`. Root accounts run commands directly. Non-root full accounts use `sudo -n`; sudo-approved uses exact absolute argv from `sudo_allow`. Do not obtain privileged credentials for user/observe tiers. Keep the existing accounts.
4. Inspect before changing and verify afterwards. Read printer activity and NAS storage cautions before updates/restarts. Never execute an allowlisted service restart merely as an authentication check.
5. Every destructive operation needs explicit human confirmation of concrete targets and effects, even on full/root. Deleting files/VMs/storage/backups, resetting configuration and formatting are included. Broad fix/update requests and native automatic approval are insufficient. Review opaque commands too.
6. Run the exact operation with `--dry-run --impact '<concrete targets, scope and consequence>'`. Resolve recursive/wildcard targets; show host, argv and effects in chat. Only after explicit confirmation use the returned digest with unchanged host/argv/impact and `--approval <digest>`. Never invent a digest to bypass asking. If a human approval UI already showed those exact details and the user approved, count it once; otherwise ask visibly in chat.
7. Respect policy errors; do not bypass with raw SSH or local shells. Full and the classifier are workflow protection, not a sandbox. Actual enforcement comes from Unix permissions and existing sudo rules; declared sudoers enforcement does not remove other privileges.
8. Keep secrets out of chat, logs, environment dumps, shell tracing and startup files. Ordinary commands use the session-aware worker without reopening KDBX. Do not delete recovery keys, encrypted backups or user files automatically. Do not deploy additional coding agents unless requested.

On authentication failure, run `homectl doctor <host> --json`. Follow classified remediation: session unlock privately, inventory/account/network checks, and trusted-console fingerprint verification before changing known_hosts. Do not repeat a failed operation before checking whether it already took effect.

Exit codes: 2 input/configuration, 3 policy/conflict, 4 exact confirmation needed, 5 transport/setup, 6 remote command failure. Report actual verification separately from assumptions. For initial setup use homelab-setup; for new hosts/VMs use homelab-enroll. Read README for session storage and TTL details.
