# homectl user guide

[← Back to the project](../README.md)

A small Bun CLI and three portable skills for operating existing homelab machines from Codex or Claude Code. One agent host runs the commands; managed machines keep their existing Unix accounts.

**KeePassXC is the only SSH credential backend.** A dedicated encrypted KDBX stores one Ed25519 key per host. Unlock privately once per configured TTL or agent-host reboot. Everyday commands use a dedicated OpenSSH agent without reopening the database. Proxmox provisioning uses the same SSH session and the node's `pvesh` command.

Human confirmation in the agent conversation is the main workflow protection. Access tiers and approval digests help make scope explicit; they are not a security sandbox.

## Install

Requirements: Bun 1.4.2+, OpenSSH, KeePassXC CLI and Bash on the agent host. Automatic key creation currently requires Linux `/dev/shm` mounted as tmpfs. On Arch/EndeavourOS, OpenSSH and KeePassXC are available from the official repositories:

```sh
sudo pacman -S --needed openssh keepassxc
bun install --frozen-lockfile
bun src/cli/main.ts setup --dry-run
bun src/cli/main.ts setup
```

Keep this checkout at a stable path. Add `~/.local/bin` to PATH if needed. Setup creates an inventory if missing, generates SSH aliases, adds an SSH Include, and links the CLI plus skills into `~/.agents/skills` and `~/.claude/skills`. It preserves existing inventory and refuses conflicting launchers or skill directories.

Run these commands **yourself in a private terminal**:

```sh
homectl session configure --ttl 24h
homectl session init
```

Choose a strong database password. Keep a secure encrypted backup. Existing configured users with a KDBX do not need to initialize again. There is no migration command or background credential-provider pairing.

## Daily use

```sh
homectl session unlock           # private terminal, password entered without echo
homectl session status --json
homectl hosts --json
homectl inspect lab-printer --json
homectl doctor lab-printer --json
homectl exec lab-printer --json -- uname -s
homectl session lock
```

The default TTL is **24 hours**, measured from the start of the session. A repeated unlock does not extend it. Configure another duration or keep keys until the agent host restarts:

```sh
homectl session configure --ttl 12h
homectl session configure --ttl until-reboot
homectl session configure --ttl 24h --database /absolute/path/homelab.kdbx
```

Configuration changes lock the current session. Durations accept `s`, `m`, `h`, `d` with a range of 1 second to 365 days. Unlock again privately afterwards. A cold reboot clears keys even with a long TTL. Suspend and restored VM snapshots are not cold reboots. Lock/expiry stops new authentication; an existing SSH connection can continue. The personal SSH agent is unaffected.

Commands that change configuration, keys, inventory or session lifecycle must run sequentially. Keep the database closed in the KeePassXC GUI while CLI commands edit it.

## Add an existing SSH host

1. Choose a name, existing SSH account and tier. Verify the SSH fingerprint through the machine's console or another trusted source before adding it to `known_hosts`. `ssh-keyscan` alone does not establish trust.
2. Privately create the host key:

   ```sh
   homectl key create lab-printer
   homectl key inspect lab-printer --json
   ```

   `create` stores the private key as an `id_ed25519` attachment inside KDBX, loads it into the dedicated agent and writes only its public key to disk. It reuses a complete existing entry and refuses a conflicting public key. `inspect` returns public material and inventory references; it does not open KDBX.
3. Install the **public key** through existing trusted access. For an existing account with password login, run this yourself in a private terminal, substituting the public-key path returned above:

   ```sh
   ssh-copy-id -i /home/operator/.config/homectl/public-keys/lab-printer.pub \
     -o StrictHostKeyChecking=yes pi@192.0.2.10
   ```

   Confirm the existing `authorized_keys` path and host scope before changing it. Preserve previous access. For UGREEN UGOS Pro, first enable **Personal Folder** for the SSH account in **Control Panel → User**, then check home ownership/permissions. Do not remove immutable protection from `/home`. See [UGREEN's SSH guide](https://ai.ugreen.com/blogs/how-to/connect-nas-ssh-root-access). On Proxmox, root's key file may be a symlink to shared cluster storage; preserve the symlink and review access to affected nodes before appending a key.
4. Copy [host.example.json](../examples/host.example.json) outside the repository. Replace address, account, description, cautions and tier. Copy the exact `auth` object from `key create`/`key inspect`; paths depend on your inventory location.
5. Review and enroll:

   ```sh
   homectl enroll lab-printer --file /path/host.json --dry-run --json
   homectl enroll lab-printer --file /path/host.json
   homectl doctor lab-printer --json
   ```

Enrollment verifies SSH and OS before saving a mode-0600 inventory. Failure preserves inventory but may refresh the generated SSH config. Mixed-case SSH usernames are supported. Enrollment does not obtain a password or alter existing accounts.

`key create` asks for the database password even when an SSH session is active: changing encrypted storage is a private administrative operation. After a restart before enrollment, rerun `key create` to load the prepared key. If other enrolled keys are also needed, lock and unlock to load the complete enrolled set.

### Access tiers

| Tier | Intended use |
| --- | --- |
| `observe` | Recognized inspection commands |
| `user` | Existing account without privileged commands |
| `sudo-approved` | Exact absolute executable/argument lists in `sudo_allow` |
| `full` | Arbitrary commands, subject to workflow review |

A root SSH account requires `full`. Root commands run directly. Other privileged accounts use `sudo -n`; passwords never enter agent chat. `enforcement: advisory` states intent. `enforcement: sudoers` declares administrator configuration, and does not prove broader group/sudo/polkit privileges were removed.

```sh
homectl sudoers lab-printer
homectl enroll lab-printer --file /path/host.json --configure-sudo
```

Use `--configure-sudo` only when requested and existing noninteractive administrator access is available. It installs literal rules for `sudo-approved`, or `NOPASSWD: ALL` for a non-root `full` account. It refuses a different existing homectl policy. Initial password-based sudo setup belongs in the user's private terminal. Existing root accounts need no sudoers installation.

### Review and confirmation

Inspect before changing and verify afterwards. Read each host's cautions, especially printer activity and NAS storage. Destructive or opaque commands require an exact plan:

```sh
homectl exec lab-nas --dry-run --impact 'Delete /srv/example; its contents will be lost' \
  -- rm -rf /srv/example
```

Show the exact host, arguments, targets and effects in chat. After the user confirms that operation, pass the returned digest using `--approval <digest>` with the unchanged host, argv and impact. A changed request invalidates approval. Do not invent approval or bypass policy errors with raw SSH. There is no `--yes` flag. `ssh <host> -- command...` is the same guarded transport, not an interactive-shell escape.

## Proxmox VM provisioning over SSH

Enroll the existing Proxmox SSH account with `full` and verify it with doctor. Non-root accounts require noninteractive sudo for `pvesh`; root runs it directly. Add this secret-free provider to the inventory:

```yaml
providers:
  lab-pve:
    type: proxmox
    host: lab-proxmox       # existing inventory machine name
    node: pve              # actual Proxmox node name
```

No separate API token is required. `pvesh --noproxy` accesses the selected node's local API through the managed SSH key. A prepared cloud-init template, its existing account, a cloud-init drive, static IPv4 settings and any needed noninteractive sudo bootstrap must already exist. Image/template import, DHCP discovery and cross-node provisioning are not implemented.

Privately prepare a separate key for the new VM:

```sh
homectl key create slicer-test
homectl key inspect slicer-test --json
```

Copy [vm.example.json](../examples/vm.example.json) outside the repository. Replace its placeholder `public_key` with the exact inspected key, and specify provider, template, VMID, resources, network, user and tier. Optional software is limited to the documented `docker`/`bun` recipes for Debian/Ubuntu templates.

```sh
homectl provision --file /path/vm.json --dry-run --json
homectl provision --file /path/vm.json
```

Review the plan with the user before applying. The CLI verifies the matching public key and that its private key can sign through the managed agent, then clones, configures/resizes, starts, waits for SSH/cloud-init, enrolls and installs only requested recipes. Establish VM SSH host-key trust through its console or another trusted source. A first run waiting for that trust can be resumed using the identical request.

The provisioning journal records ownership and task progress. VMID/name conflicts, changed plans and uncertain task state require inspection. Do not delete a VM, erase its journal or recreate storage to force a retry. Failed operations retain state and do not perform destructive rollback. A public key prepared before a restart must be loaded again with private `key create` before applying.

## Configuration and credential storage

The default paths are:

| Path | Contents |
| --- | --- |
| `~/.config/homectl/inventory.yaml` | Secret-free accounts, addresses, tiers and references |
| `~/.config/homectl/homelab.kdbx` | Encrypted dedicated key database |
| `~/.config/homectl/public-keys/` | Public keys only |
| `~/.config/homectl/inventory.yaml.session/` | Private runtime control and agent sockets |
| `~/.config/homectl/ssh_config` | Generated SSH aliases |
| `~/.config/homectl/state/` | VM provisioning journals |

Use `--inventory /absolute/path/inventory.yaml` for another inventory; socket and public-key paths follow that file's location. KDBX paths are absolute. [inventory.example.yaml](../examples/inventory.example.yaml) illustrates the complete schema. Keep real inventory, KDBX, backups and runtime files outside Git.

Each KDBX entry has an unencrypted OpenSSH key attachment *inside the encrypted database*. Unlock exports it through private pipes into the dedicated agent. The supervisor retains neither the database password nor decrypted KDBX. SSH authenticates using signatures, `IdentityAgent`, a public `IdentityFile`, `IdentitiesOnly yes`, strict host-key checks, password login disabled and no agent forwarding.

Private initialization/key creation/unlock must never run through model-visible password entry. Do not put passwords or session values in shell startup files. Same-user processes can use an unlocked socket; root/hypervisor access and VM snapshots can expose memory. Temporary key generation uses a private tmpfs directory, removed after import; tmpfs can be swapped. Encrypted swap and snapshot protection are host responsibilities. Buffer clearing is best effort, not guaranteed erasure.

Automatic `key create` currently requires Linux tmpfs. On macOS, initial key preparation and inventory configuration are manual: privately import an Ed25519 key as the entry's `id_ed25519` attachment, create its matching public file, and add the managed auth references and session configuration to inventory before private `session unlock` and `doctor`. Managed socket paths follow `<absolute-inventory-path>.session/agent.sock`. CLI private commands use Bash and the system KeePassXC/OpenSSH tools.

Keep encrypted backups separate from the live database. Key creation takes a mode-0600 encrypted backup before editing. An incomplete entry is preserved for manual repair; it is never silently replaced. Existing keys, recovery passwords, vault data and old backups are not automatically deleted by project setup.

## Troubleshooting and development

```sh
homectl help
homectl session status --json
homectl doctor --json
homectl doctor lab-proxmox --json
```

Doctor checks tools; a named host adds a real managed-key SSH probe. A root account skips sudo checks. A non-root full account checks `sudo -n true`. Limited sudo checks never execute a service restart. Doctor does not open KDBX. On expiry, unlock privately. On host-key rejection, verify the fingerprint before editing known_hosts. On network/authentication errors, inspect address, account, installed public key and session status. Raw credential diagnostics are suppressed.

Exit codes: `0` success; `2` input/configuration; `3` policy/conflict; `4` exact confirmation required; `5` transport/setup; `6` remote command failed.

Development commands:

```sh
bun run typecheck
bun run lint
bun test
```

The session integration tests require OpenSSH and KeePassXC CLI. They create synthetic encrypted databases, keys and dedicated sockets in owned temporary directories, then remove those fixtures. They verify signing, unlock/lock, absolute TTL, repeat unlock, isolation between agents, configuration changes and failure cleanup. They never use your personal database or SSH agent. Proxmox adapter tests run entirely without SSH, network access, node credentials or a Proxmox installation. They cover pvesh method/path mapping, argument quoting, cloud-init key encoding, task polling and timeout, response errors, and provisioning/resume through simulated process responses. GitHub Actions runs them as part of `bun test`. Other tests use fixtures, fake provisioning responses and local subprocesses. These checks do not prove deployment or real VM creation. See [architecture](architecture.md) and [primary sources](research.md). This repository does not deploy additional coding agents to managed hosts.
