# Architecture and implementation decisions

Reviewed 2026-10-01. This repository manages infrastructure; it never deploys another coding agent unless separately requested.

Three portable Agent Skills orchestrate a Bun/TypeScript CLI. Inventory is local YAML validated against a strict JSON Schema. Local and SSH transports share command policy, execution planning, dry-run, and output handling. SSH aliases are rendered into a dedicated config (one canonical address in inventory), with strict host-key verification and no agent forwarding.

## Policy versus enforcement

Access tiers are workflow policy. Observe uses a conservative inspection command grammar; user denies direct privilege escalation. Sudo-approved accepts exact argv allowlists and can install matching sudoers. Full accepts arbitrary commands and `sudo -n`; NOPASSWD: ALL is intentional. Neither argv classification nor an LLM instruction is a general sandbox. Existing Unix users, SSH config, sudoers and Proxmox ACLs remain the actual system boundaries. Existing root accounts require full.

Known destructive commands and opaque commands require approval. Exact host/config/argv/impact are fingerprinted. A digest is an attestation of already received user confirmation, not cryptographic evidence of a human. Skills must never fabricate approval. A native prompt showing the exact operation counts once; auto-approval does not count as explicit user confirmation. Observe and privilege restrictions cannot be overridden with an approval digest. Unknown/opaque commands remain available with specific approval on permissive hosts.

## Credential routing

Official Bitwarden SSH Agent handles keys without key material entering homectl. It is part of the desktop app, including Linux desktop; this is not a headless bw SSH agent. A local ssh-agent is supported. For password SSH, `aac run --id ... --env HOMECTL_SSH_PASSWORD=password -- bun ...` launches only a narrowly scoped worker. The worker starts OpenSSH with an askpass helper; only that helper's stdout carries the password to OpenSSH. Worker output is redacted before it reaches the outer CLI. It does not send the password in argv, stdin commands, inventory, or remote environment. Processes owned by the same user/root can still inspect environment/memory. Arbitrary secret exfiltration by malicious software is outside this threat model.

Proxmox similarly runs a private API worker through aac, mapping the vault password field to an API token secret. No token is printed. Strict HTTPS, no insecure switch. Agent Access is early preview; aac syntax is checked by doctor. Pair/unlock via provider UI/terminal outside the model transcript. Unlock and per-request approval are distinct; `bw status` is not proof that the AAC listener is ready, and temporary accept-all approval can expire. A reusable pairing option persists a token on disk and should only be used by explicit choice. Never put `BW_SESSION` in a shell startup file. No automatic master-password handling, no aac connect credential JSON, no guessed SDK binding. homectl does not implement caching; aac/provider governs persisted pairing and authorization. Headless Linux x86_64 client is documented; unattended approval/provider availability is not guaranteed.

Enrollment and doctor classify common AAC timeout, SSH host-key/authentication, DNS and network failures without returning raw provider output. AAC log lines are removed from the successful `uname -s` result. A failed enrollment leaves inventory unchanged, but the generated SSH config may already have been refreshed. Doctor skips the sudo probe for a root SSH account because that account already runs as root.

## Provisioning

A Proxmox provider clones a prepared cloud-init template, configures CPU/RAM/network/public SSH key, grows the selected disk, boots, waits for bounded API tasks and SSH, verifies cloud-init, installs a requested sudoers policy for non-root users, and enrolls atomically. Root template users on full skip sudoers installation and run requested package recipes directly. Use an explicit VMID, static address and template user. Journal records stage and owned VM identity; collisions and mismatched plans fail without deleting/recreating anything. No automatic destructive rollback. Provisioning plans are pure and tests use an in-memory API fake. Additional providers implement the same interface.

Template/image import, DHCP address discovery, cross-node migration and provider credential release semantics are deferred explicitly. SSH access to a Proxmox host does not validate the separate VM provisioning API path. Automated checks use a fake API; validate the API operations and ACLs against the node's API viewer before first real apply.

## Official sources

- https://github.com/bitwarden/agent-access (early preview, Linux x86_64, aac listen/run, field mapping)
- https://bitwarden.com/help/ssh-agent/ (desktop agent and platform sockets)
- https://developers.openai.com/codex/skills/ (redirects to https://learn.chatgpt.com/docs/build-skills; .agents/skills)
- https://code.claude.com/docs/en/skills (.claude/skills and portable format)
- https://pve.proxmox.com/wiki/Cloud-Init_Support
- https://pve.proxmox.com/pve-docs/api-viewer/index.html
- https://github.com/proxmox/qemu-server/blob/master/PVE/API2/Qemu.pm

The Proxmox documentation host was inaccessible through the research fetcher. Source/API validation is tracked as a first-use requirement, not represented as a successful live test.
