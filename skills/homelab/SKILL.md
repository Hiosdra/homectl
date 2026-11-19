---
name: homelab
description: Operate inventory machines through homectl using existing Unix accounts, KeePassXC SSH sessions and access tiers. Use for homelab inspection, troubleshooting, updates or service restarts.
---

## Communication

Apply this skill without routinely quoting its paragraphs, listing rule numbers or explaining each action by reference to the skill. Report actions, results and relevant limitations in plain language. Mention skill use once when required by the host's instructions. If a skill rule actually requires approval or blocks progress, briefly identify the skill and the specific reason once at that decision; do not repeat it in later updates unless the situation changes. Explain rules in more detail only when the user asks. This changes communication, not authorization or safety requirements.

1. Run `home-ctl hosts --json` and `home-ctl inspect <host> --json`. Read purpose, cautions, tier and transport. Resolve ambiguity visibly in chat; never substitute a more permissive host.
2. Check `home-ctl session status --json` before remote work. If locked/expired, ask the user to run `home-ctl session unlock` in a private terminal. Never obtain the database password, export attachments or read private keys through model-visible tools. Repeated unlock preserves expiry; lock clears only the dedicated homelab agent. Expiry/reboot stops new authentication, not established connections.
3. Use `home-ctl exec <host> --json -- <executable> <separate argv...>`. Root accounts run commands directly. Non-root full accounts use `sudo -n`; sudo-approved uses exact absolute argv from `sudo_allow`. Do not obtain privileged credentials for user/observe tiers. Keep the existing accounts.
4. Inspect before changing and verify afterwards. Read printer activity and NAS storage cautions before updates/restarts. Never execute an allowlisted service restart merely as an authentication check.
5. Every destructive operation needs explicit human confirmation of concrete targets and effects, even on full/root. Deleting files/VMs/storage/backups, resetting configuration and formatting are included. Broad fix/update requests and native automatic approval are insufficient. Review opaque commands too.
6. Pass `--impact '<concrete targets, scope and consequence>'` with every change. Resolve recursive/wildcard targets first. When the result says the operation is waiting for the owner, tell the user which host, argv and effect are waiting and where to approve (panel or `home-ctl approve <operation>`), then run `home-ctl wait <operation> --json`. You cannot approve your own operation; never ask the user for their owner password in chat, and never try to work around a denial. homectl does not retry: read the final state before deciding what to do next. An `unknown` state means it may or may not have run; inspect before acting again.
7. Respect policy errors; do not bypass with raw SSH or local shells. Full and the classifier are workflow protection, not a sandbox. Actual enforcement comes from Unix permissions and existing sudo rules; declared sudoers enforcement does not remove other privileges.
8. Keep secrets out of chat, logs, environment dumps, shell tracing and startup files. Ordinary commands use the session-aware worker without reopening KDBX. Do not delete recovery keys, encrypted backups or user files automatically. Do not deploy additional coding agents unless requested.

On authentication failure, run `home-ctl doctor <host> --json`. Follow classified remediation: session unlock privately, inventory/account/network checks, and trusted-console fingerprint verification before changing known_hosts. Do not repeat a failed operation before checking whether it already took effect.

Exit codes: 2 input/configuration, 3 policy/conflict, 4 waiting for or refused by the owner, 5 transport/setup, 6 remote command failure. Report actual verification separately from assumptions. For initial setup use homelab-setup; for new hosts/VMs use homelab-enroll. Read README for session storage and TTL details.
