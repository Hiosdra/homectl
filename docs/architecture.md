# Architecture

## Flow

```text
Codex / Claude → homectl → inventory + policy → managed SSH worker → OpenSSH → existing Unix account
                                      ↑
                       dedicated ssh-agent with absolute TTL
                                      ↑
                 private user-run unlock ← encrypted KeePassXC KDBX
```

The same agent host runs local commands and all remote operations. Remote-control clients approve the conversation; they do not receive keys or database passwords. One SSH authentication backend keeps daily operation independent of a separate vault listener.

## Modules

- `cli`: argument validation and command orchestration. Strict options; no universal approval bypass.
- `inventory`: YAML/schema validation, secret-field rejection, atomic mode-0600 persistence. Root SSH requires full; providers reference an enrolled full SSH host.
- `policies`: access tiers, literal sudo allowlists, command classification and exact approval fingerprints. This is workflow protection, not a shell sandbox or hard privilege isolation.
- `transports`: quoted argv and generated aliases. Managed SSH selects one public identity, a dedicated socket, strict host-key checking and no password authentication/forwarding.
- `credentials`: session-aware SSH worker. It checks supervisor expiry, passes socket references and runs OpenSSH without reopening KDBX.
- `session`: configuration, private password/database subprocesses, a dedicated agent supervisor, absolute expiry and lock. Passwords are never retained by the supervisor.
- `session/database`: private one-time initialization, refusing an existing database.
- `session/keys`: private key preparation/reuse, encrypted backups, tmpfs staging and public references. Key installation is an explicit user-admin bootstrap step through existing trusted access.
- `enroll`: validates configuration and SSH/OS before saving; optional explicit sudoers bootstrap preserves a different existing policy by refusing replacement.
- `provisioners`: deterministic cloud-init plans, task/ownership journals and resumable provisioning. `ssh` maps allowed operations to node-local `pvesh` over the same managed-key worker.
- `setup`: additive per-user CLI/skill links, SSH Include and doctor.

## Session lifecycle

The default lifetime is 24h; configurable durations span 1s–365d, or `until-reboot`. Expiry is absolute and repeated unlock does not slide it. Configuration changes lock the current agent. OpenSSH key lifetime constrains timed sessions alongside the supervisor check. Cold reboot loses keys; suspend or snapshot restoration is different. Expiry affects new authentication, not established connections. Lock never clears the personal agent.

A private unlock reads a no-echo password, exports only enrolled key attachments into private pipes and loads the dedicated agent. Keys/passwords do pass through CLI memory. Clearing buffers is best effort; string copies/runtime allocations cannot guarantee erasure. Same-user processes can use an unlocked agent; root/hypervisor access is outside isolation guarantees.

KDBX attachments are unencrypted OpenSSH keys within encrypted KDBX. Automatic generation requires Linux tmpfs; owned staging directories/files are mode 0700/0600 and removed in a finally block. Tmpfs may swap. Existing complete keys are reused; missing attachments and conflicting public files require manual repair. CLI edits require exclusive use of the database. Passwords, encrypted backups and private files stay outside Git and agent transcripts.

For a new host, `key create` prepares and loads a key, the user installs the public file through trusted access, then enrollment verifies it. `key inspect` exposes only public data. An unregistered VM key is not part of ordinary inventory unlock; rerun private `key create` to load it after reboot before provisioning/enrollment.

## Proxmox

A provider stores `{type: proxmox, host: <inventory-name>, node: <node-name>}`. Its host must have managed SSH and full access. Root runs `pvesh` directly; another account uses `sudo -n`. No separate token secret or HTTP credential worker exists.

The adapter maps GET/POST/PUT to `get`/`create`/`set`, with `--noproxy` and JSON output. It restricts paths to the configured node and provisioning resources: QEMU list/config, clone/start/config/resize and task status. It quotes every argument through the standard transport. Task waits are bounded; errors suppress raw output.

Plans clone an existing cloud-init template, configure CPU/RAM/network/user/key, grow the requested disk and start. Journals retain plan fingerprints, completed/pending steps and task IDs. Resume checks VM ownership rather than blindly cloning again. Changed requests, VMID conflicts and uncertain state stop for inspection. There is no automatic destructive rollback. SSH readiness still requires out-of-band host-key verification. Post-provision enrollment/software recipes use the same session-aware worker.

Template/image import, DHCP discovery and cross-node operations are deferred. Static/fake checks do not prove real provisioning, template correctness or node permissions.

## Host-specific bootstrap

UGREEN home directories should be provisioned by enabling Personal Folder in the vendor UI. Do not bypass immutable `/home`. Proxmox authorized_keys may reference cluster-managed storage: preserve its symlink and review all affected nodes before adding access. No bootstrap flow removes old keys, changes users or tightens unrelated sudo rules implicitly.

Human approval remains a conversation workflow. Actual restrictions come from Unix accounts and administrator configuration; an inventory tier cannot undo existing root/sudo privileges.
