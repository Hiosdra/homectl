# homectl user guide

[← Back to the README](../README.md)

homectl is a small CLI and three agent skills. Your agent operates your existing machines through their existing Unix accounts. All SSH keys live in one encrypted KeePassXC database.

**Human confirmation in the agent conversation is the main protection.** Access tiers and approval digests make scope explicit. They are not a security sandbox.

## Install

The [README](../README.md#install) covers packages, Homebrew and release archives. This guide covers the source checkout, which also installs the agent skills.

You need Bun 1.4.4 or newer, OpenSSH, the KeePassXC CLI and Bash on the agent host. Automatic key creation currently needs Linux with `/dev/shm` mounted as tmpfs. On Arch or EndeavourOS:

```sh
sudo pacman -S --needed openssh keepassxc
```

From the checkout:

```sh
bun install --frozen-lockfile
bun src/cli/main.ts setup --dry-run
bun src/cli/main.ts setup
```

Setup creates an inventory if you have none, generates SSH aliases, adds an SSH Include, and links the CLI and skills into `~/.agents/skills` and `~/.claude/skills`. It keeps your inventory and refuses to overwrite conflicting launchers or skill folders. Keep the checkout at a stable path, and add `~/.local/bin` to your PATH if needed.

Then run these **yourself in a private terminal**:

```sh
home-ctl session configure --ttl 24h
home-ctl session init
```

Choose a strong database password and keep an encrypted backup of the database. If you already have a configured database, you do not need to initialize again.

## Daily use

```sh
home-ctl session unlock           # private terminal; the password is not echoed
home-ctl session status
home-ctl hosts
home-ctl inspect lab-printer
home-ctl doctor lab-printer
home-ctl exec lab-printer -- uname -s
home-ctl session lock
```

The default session lasts **24 hours** from when it starts. Unlocking again does not extend it. To change that:

```sh
home-ctl session configure --ttl 12h
home-ctl session configure --ttl until-reboot
home-ctl session configure --ttl 24h --database /absolute/path/homelab.kdbx
```

Durations accept `s`, `m`, `h` and `d`, from 1 second to 365 days. Changing the configuration locks the session, so unlock again afterwards. A cold reboot clears the keys even with a long TTL. Suspend and restored VM snapshots are not cold reboots. Locking stops new logins, but an open SSH connection can continue. Your personal SSH agent is not affected.

Run commands that change configuration, keys, inventory or sessions one at a time. Keep the database closed in the KeePassXC app while the CLI edits it.

## Add an existing machine

1. **Verify the machine first.** Choose a name, an existing SSH account and an access tier. Check the SSH fingerprint through the machine's console or another trusted source. `ssh-keyscan` alone does not establish trust.
2. **Create its key privately:**

   ```sh
   home-ctl key create lab-printer
   home-ctl key inspect lab-printer
   ```

   `create` stores the private key inside the database, loads it into the dedicated agent, and writes only the public key to disk. It reuses a complete existing entry and refuses a conflicting public key. `inspect` shows public material and inventory references, without opening the database.

   `key create` asks for the database password even when a session is active, because changing encrypted storage is a private administrative step. After a restart before enrollment, run `key create` again to load the prepared key.

3. **Install the public key** through access you already have. Confirm the `authorized_keys` path and host scope first, and keep existing access in place:

   ```sh
   ssh-copy-id -i /home/operator/.config/homectl/public-keys/lab-printer.pub \
     -o StrictHostKeyChecking=yes pi@192.0.2.10
   ```

   Notes for specific systems:
   - **UGREEN UGOS Pro:** first enable **Personal Folder** for the SSH account in **Control Panel → User**, then check home ownership and permissions. Do not remove immutable protection from `/home`. See [UGREEN's SSH guide](https://ai.ugreen.com/blogs/how-to/connect-nas-ssh-root-access).
   - **Proxmox:** root's key file may be a symlink to shared cluster storage. Keep the symlink, and review access to the affected nodes before you append a key.

4. **Describe the machine.** Copy [host.example.json](../examples/host.example.json) outside the repository. Set the address, account, description, cautions and tier, and copy the `auth` object from `key inspect`.
5. **Review, then enroll:**

   ```sh
   home-ctl enroll lab-printer --file /path/host.json --dry-run
   home-ctl enroll lab-printer --file /path/host.json
   home-ctl doctor lab-printer
   ```

   Enrollment checks SSH and the OS before it saves a mode-0600 inventory entry. It does not set passwords or change existing accounts.

## Access tiers

| Tier | Intended use |
| --- | --- |
| `observe` | Recognized inspection commands |
| `user` | Existing account, no privileged commands |
| `sudo-approved` | Exact absolute commands listed in `sudo_allow` |
| `full` | Arbitrary commands, subject to review |

A root account requires `full`. Root commands run directly. Other privileged accounts use `sudo -n`. Passwords never enter agent chat. `enforcement: advisory` only states intent. `enforcement: sudoers` declares administrator configuration, but it does not prove that broader group, sudo or polkit privileges were removed.

```sh
home-ctl sudoers lab-printer
home-ctl enroll lab-printer --file /path/host.json --configure-sudo
```

Use `--configure-sudo` only when you ask for it and noninteractive administrator access exists. It installs literal rules for `sudo-approved`, or `NOPASSWD: ALL` for a non-root `full` account. It refuses a different existing homectl policy. Do the first password-based sudo setup in your own private terminal. Root accounts need no sudoers installation.

## Review before changes

Inspect before you change anything, and verify afterwards. Read each machine's cautions, especially for printers and NAS storage. Destructive or opaque commands need an exact plan:

```sh
home-ctl exec lab-nas --dry-run --impact 'Delete /srv/example; its contents will be lost' \
  -- rm -rf /srv/example
```

Show the exact host, arguments, targets and effects to the user. After they confirm, run the command with the returned digest as `--approval <digest>`, using the same host, argv and impact. Any change invalidates the approval. There is no `--yes` flag. Do not bypass a policy error with raw SSH. `ssh <host> -- command...` uses the same guarded path and is not an interactive shell.

## Proxmox VM provisioning over SSH

Enroll the Proxmox SSH account with `full` and check it with `doctor`. Non-root accounts need noninteractive sudo for `pvesh`; root runs it directly. Add a provider to the inventory. It holds no secrets:

```yaml
providers:
  lab-pve:
    type: proxmox
    host: lab-proxmox       # existing inventory machine name
    node: pve               # actual Proxmox node name
```

No API token is needed. `pvesh --noproxy` reaches the node's local API through the managed SSH key. You need an existing cloud-init template with its account, a cloud-init drive, static IPv4 settings and any noninteractive sudo bootstrap. Image import, DHCP discovery and cross-node provisioning are not implemented.

Prepare a separate key for the new VM:

```sh
home-ctl key create slicer-test
home-ctl key inspect slicer-test
```

Copy [vm.example.json](../examples/vm.example.json) outside the repository. Replace its placeholder `public_key` with the inspected key, and set the provider, template, VMID, resources, network, user and tier. Optional software is limited to the documented `docker` and `bun` recipes for Debian and Ubuntu templates.

```sh
home-ctl provision --file /path/vm.json --dry-run
home-ctl provision --file /path/vm.json
```

Review the plan before you apply it. homectl checks that the public key matches and that the private key can sign through the agent. Then it clones, configures and starts the VM, waits for SSH and cloud-init, enrolls it, and installs only the recipes you requested. Confirm the VM's SSH host key through its console or another trusted source. If a run waits for that trust, run the identical request again to resume.

The provisioning journal records ownership and progress. Conflicts, changed plans and uncertain task states need inspection. Do not delete a VM, erase its journal or recreate storage to force a retry. Failed operations keep their state and do not roll back destructively. A public key prepared before a restart must be loaded again with `key create` before you apply.

## Configuration and credential storage

| Path | Contents |
| --- | --- |
| `~/.config/homectl/inventory.yaml` | Secret-free accounts, addresses, tiers and references |
| `~/.config/homectl/homelab.kdbx` | Encrypted dedicated key database |
| `~/.config/homectl/public-keys/` | Public keys only |
| `~/.config/homectl/inventory.yaml.session/` | Private runtime control and agent sockets |
| `~/.config/homectl/ssh_config` | Generated SSH aliases |
| `~/.config/homectl/state/` | VM provisioning journals |

Use `--inventory /absolute/path/inventory.yaml` for another inventory. Socket and public-key paths then follow that file's location. Database paths are absolute. The [inventory example](../examples/inventory.example.yaml) shows the full schema. Keep the real inventory, the database, backups and runtime files outside Git.

- **One key per host.** KeePassXC is the only SSH credential backend. Each entry holds an Ed25519 key as an OpenSSH attachment inside the encrypted database.
- **Unlock loads the agent.** Unlock sends the keys through private pipes into a dedicated OpenSSH agent. The supervisor keeps neither the database password nor the decrypted database.
- **Strict SSH settings.** Connections use signatures, a dedicated `IdentityAgent`, a public `IdentityFile`, `IdentitiesOnly yes`, strict host-key checks, password login disabled and no agent forwarding.
- **Know the limits.** Processes running as your user can use an unlocked socket. Root, hypervisor access and VM snapshots can expose memory. Encrypted swap and snapshot protection are your host's responsibility. Clearing buffers is best effort, not guaranteed erasure.
- **Keep secrets out of chat.** Initialization, key creation and unlock must never run through a password prompt the model can see. Do not put passwords or session values in shell startup files.
- **Backups.** `key create` takes a mode-0600 encrypted backup before it edits the database. An incomplete entry is kept for manual repair and is never silently replaced. Setup never deletes existing keys, recovery passwords or old backups.

**macOS:** key preparation and inventory setup are manual for now. Import an Ed25519 key privately as the entry's `id_ed25519` attachment, create the matching public file, and add the auth references and session settings to the inventory. Then run a private `session unlock` and `doctor`. Managed socket paths follow `<absolute-inventory-path>.session/agent.sock`.

## Troubleshooting and development

```sh
home-ctl help
home-ctl session status
home-ctl doctor
home-ctl doctor lab-proxmox
```

- **Session expired:** unlock again privately.
- **Host key rejected:** verify the fingerprint before you edit `known_hosts`.
- **Network or login error:** check the address, the account, the installed public key and the session status.

`doctor` checks the tools. With a host name, it also runs a real SSH probe using the managed key. A root account skips sudo checks. A non-root full account checks `sudo -n true`. Limited sudo checks never restart a service. `doctor` does not open the database, and raw credential details are suppressed.

Exit codes: `0` success; `2` input or configuration; `3` policy or conflict; `4` exact confirmation required; `5` transport or setup; `6` remote command failed.

### Verification status

Verified:
- Linux packages (deb, rpm, pacman, apk) install and run in clean containers (Debian 12, Fedora 41, Alpine 3.20, Arch). The release workflow checks `home-ctl help` and an unknown-command exit code in each.
- CI runs typecheck, lint, the full test suite and browser UI tests on Linux. On Windows it runs typecheck, lint, a subset of the tests, and PowerShell, CMD and Git Bash smoke tests.

Not verified yet:
- The macOS runtime, including `brew install` on a Mac.
- Two real devices that pair, sync, hand off and take over over your LAN.
- Windows named pipes, ACL enforcement, service accounts and WSL networking on your own hardware.

### Development

```sh
bun run typecheck
bun run lint
bun test
```

The session tests need OpenSSH and the KeePassXC CLI. They create synthetic databases, keys and sockets in temporary directories, then remove them. They never touch your database or SSH agent. Proxmox adapter tests run without SSH, network access or a Proxmox install. See [architecture](architecture.md). homectl does not install coding agents on managed hosts.
