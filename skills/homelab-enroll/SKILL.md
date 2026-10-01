---
name: homelab-enroll
description: Adopt existing SSH/local machines or provision cloud-init VMs on Proxmox through homectl, using managed KeePassXC keys and the requested access tier.
---

## Communication

Apply this skill without routinely quoting its paragraphs, listing rule numbers or explaining each action by reference to the skill. Report actions, results and relevant limitations in plain language. Mention skill use once when required by the host's instructions. If a skill rule actually requires approval or blocks progress, briefly identify the skill and the specific reason once at that decision; do not repeat it in later updates unless the situation changes. Explain rules in more detail only when the user asks. This changes communication, not authorization or safety requirements.

1. Read README enrollment/provisioning instructions. Use existing Unix users. Resolve name, purpose and access from the request; preserve an explicitly selected full tier. Root SSH requires full. Mixed-case usernames are supported.
2. ADOPT: have the user run `homectl key create <name>` privately. `key inspect <name> --json` returns the public key and auth references safely. Verify the host fingerprint through trusted console/source, then have the user install only that public key using existing trusted access, e.g. private ssh-copy-id with strict host-key checking. Keep passwords/private keys outside the agent transcript. Preserve existing access.
3. On UGREEN, enable Personal Folder through UGOS before key installation and verify home permissions; never remove immutable /home protection. On Proxmox, inspect authorized_keys symlinks/cluster scope and preserve them when appending. Adding cluster-wide access requires review of all affected nodes.
4. Prepare a secret-free host JSON from examples/host.example.json outside Git, copying exact managed auth references. Review `homectl enroll <name> --file <path> --dry-run --json`, then enroll. Enrollment verifies key-only SSH/OS before saving; failure preserves inventory but may refresh SSH config. Run enrollments sequentially.
5. Use --configure-sudo only when requested and existing noninteractive administrative bootstrap works. Full installs NOPASSWD: ALL for a non-root account; sudo-approved installs exact literal rules. Root needs no sudoers. Initial password-based sudo setup is private user work. Existing broader grants remain; tightening them requires separate concrete scope.
6. PROVISION: reference an enrolled full Proxmox SSH host with a provider containing type, host and node. Root runs pvesh; non-root requires sudo -n. No API token is needed. Use an existing prepared cloud-init template/account/drive and privilege bootstrap. Image import, DHCP discovery and cross-node provisioning are deferred.
7. Have the user privately run `key create <vm-name>`; copy `key inspect` publicKey into the VM request from examples/vm.example.json. Specify template/VMID/resources/static IPv4/network/user/tier and only requested docker/bun recipes. Never include private material. If the prepared key was lost on reboot before enrollment, rerun key create privately to load it.
8. Review `homectl provision --file <path> --dry-run --json` and apply the user's requested creation. The CLI uses SSH/pvesh, waits for tasks and SSH/cloud-init, enrolls, and installs requested recipes. Establish the VM host fingerprint out of band; first-run SSH timeout can be resumed after fixing trust.
9. Resume with the identical request. Inspect changed plans, VMID conflicts or uncertain task results; never erase journals, delete/recreate VMs or roll back storage automatically. Destruction requires homelab skill's exact confirmation flow.
10. Run inspect/doctor afterwards and report actual verification. Declared tier is not proof of restricted system privileges. Do not install Codex/Claude on the new machine unless separately requested.

Use session status and private user-run unlock on expiry. Lifecycle/database operations run sequentially. Ask unresolved choices/required approvals visibly in chat with concrete effects. Never request the KDBX password or bootstrap password in chat.
