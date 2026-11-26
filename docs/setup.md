# Setup

This guide covers installing homectl 0.3.0, the first run, connecting agents and machines, moving from 0.2, and the platform differences. Trust decisions (host pinning, sudo grants, approvals) are explained in [security](security.md). Command syntax is in [reference](reference.md).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Your first 15 minutes](#your-first-15-minutes)
- [First run](#first-run)
- [Run the broker](#run-the-broker)
- [Connect an agent](#connect-an-agent)
- [Add a machine](#add-a-machine)
- [Upgrade from 0.2](#upgrade-from-02)
- [Platform notes](#platform-notes)
- [Verification status](#verification-status)

## Requirements

- **OpenSSH client** (`ssh`) on the computer that runs homectl.
- **KeePassXC CLI** (`keepassxc-cli`). `home-ctl setup` checks for both tools. The session and key commands use the KeePassXC CLI.
- **Bun 1.4.5 or newer**, only for a source checkout.
- **systemd**, only for the hardened broker on Linux (see [platform notes](#linux)).

Run `home-ctl doctor` after setup to check the tools.

## Install

Pick the package for your system from the latest release.

| System         | Get it                                                                                                        | Install                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Debian, Ubuntu | the `.deb` package                                                                                            | `sudo apt-get install ./<file>.deb`                                                                                                          |
| Fedora, RHEL   | the `.rpm` package                                                                                            | `sudo dnf install ./<file>.rpm`                                                                                                              |
| Arch Linux     | the `.pkg.tar.zst` package                                                                                    | `sudo pacman -U ./<file>.pkg.tar.zst`                                                                                                        |
| Alpine Linux   | the `.apk` package (musl builds)                                                                              | `sudo apk add --allow-untrusted ./<file>.apk`                                                                                                |
| Linux or macOS | `homectl-<version>-linux-x64.tar.gz`, `homectl-<version>-macos-arm64.tar.gz` and the other `.tar.gz` archives | Unpack and put `home-ctl` on your PATH                                                                                                       |
| Windows        | `homectl-<version>-windows-x64.zip`                                                                           | Unzip and run `home-ctl.exe setup`                                                                                                           |
| Homebrew       | `brew tap Hiosdra/tap` then `brew install homectl`                                                            | <!-- verify: no Homebrew step appears in .github/workflows/release.yml in this repository; confirm the tap exists before documenting it. --> |

Use the file names from the release you download. The Linux packages are built by the release workflow with nfpm (`scripts/build-packages.ts`). The workflow installs them in clean containers and runs `home-ctl help` there. The archives are listed in `SHA256SUMS`, and the release manifest is signed.

### From a source checkout

For development, or to follow the repository directly (Bun 1.4.5+):

```sh
git clone https://github.com/Hiosdra/homectl.git
cd homectl
bun install --frozen-lockfile
bun src/cli/main.ts setup
```

Setup then links the skills from `skills/` instead of copying them, so edits take effect at once. Keep the checkout at a stable path. Update it with `home-ctl update`, which fast-forwards the current branch from its upstream and reinstalls dependencies. A compiled release refuses `home-ctl update`; install the newer release instead.

The owner panel can update a Windows x64 release build of the broker. It shows the offered version and whether its release signature verifies; applying asks for the owner password, installs only that exact version after its signature checks, and stages it beside the running one, so it takes effect on the next start. It cannot update a source checkout (use `home-ctl update`), a container (redeploy the image), an install owned by a package manager such as Scoop, WinGet, Chocolatey or Homebrew (use that manager), or other platforms (install the release from the release page). The update status carries the reason.

### What `setup` does

Run `home-ctl setup --dry-run` first. It lists every change before it makes one.

- Creates `~/.config/homectl/inventory.yaml` if it does not exist. Existing inventory files are kept.
- Adds an `Include` for `~/.config/homectl/ssh_config` to `~/.ssh/config`. That file holds the SSH aliases for your machines.
- Puts the `home-ctl` launcher in `~/.local/bin`. On Windows it writes `home-ctl.cmd`, `home-ctl.ps1` and `home-ctl` (for Git Bash) to `%USERPROFILE%\.local\bin`, and adds that folder to your user PATH.
- Installs the three skills (`homelab`, `homelab-setup`, `homelab-enroll`) into `~/.agents/skills` and `~/.claude/skills`. Setup never overwrites a launcher or skill folder it did not create.
- Optional: `--install-deps` installs missing tools. This needs administrator rights, and on Windows it uses winget for KeePassXC.
- Optional: `--configure-firewall --interface <LAN-IP>` opens UDP 5353 and TCP 7448 for your LAN subnet only. On Windows the rules apply to the Private profile only. Without `--interface`, a non-interactive run refuses this option.

Restart your terminal after the first setup on Windows so the new PATH is loaded.

## Your first 15 minutes

Run `home-ctl setup` in a private terminal. At the end it offers to start homectl, which opens the owner panel on the guided setup; the setup page stays the place to go until it is complete. A checklist also sits at the top of **Needs you** until then. You can stop at any step and come back.

1. **Welcome.** Read what homectl does, then start.
2. **Vault and sign-in.** `home-ctl setup` creates the vault. Its password is also your owner password: signing in opens the vault.
3. **Add your first machine.** Run `home-ctl key create <name>` in a private terminal, then use **Add a machine** in the panel. Nothing is trusted until you have checked the machine's fingerprint on its own console.
4. **Connect an assistant.** Add it in the panel, then run the one command it shows on the assistant's computer. The panel waits until the assistant connects.
5. **First safe request.** Paste the read-only prompt into Claude or Codex, then the small change. You approve the change in Needs you; nothing runs before that.
6. **Choose how much homectl decides.** Keep "Ask me first", which is the default, or pick another level in Permissions.
7. _Optional:_ **a second device and backups**, see [workspace](workspace.md).
8. _Optional:_ **notifications and updates**: allow alerts, check the version, or start homectl when you sign in.

Each step can be skipped and reopened. The broker keeps the progress in `broker/setup.json` (booleans and timestamps only), so a new browser keeps your place. A step counts as done only when homectl can see the real state, such as a machine that is pinned and answered its check. Two marks come from you alone: keeping "Ask me first", and allowing notifications in the browser. After an upgrade from 0.2 that carried machines, the panel says once what changed and asks you to connect each assistant again.

Once an assistant is connected, it can prepare additional machine setup and AI helper requests. For `setup_ai_helper`, review the exact provider address and model in **Needs you** on the originating device. Enter any key there and approve with your owner password. The request saves the connection without enabling Auto Mode or widening its authority.

## First run

Run the secret-handling commands in a **private terminal** yourself. They prompt for passwords, and an agent must never see those prompts.

```sh
home-ctl session configure --ttl 24h   # how long the unlocked session lasts
home-ctl session init                  # create the encrypted database
home-ctl key create lab-printer        # make this machine's key, stored in the database
home-ctl key inspect lab-printer       # show the public key to install
```

- Choose a strong vault password and keep an encrypted backup of the vault file. The vault password is also your owner password: signing in to the panel with it opens the vault. Setup never deletes existing keys, recovery passwords or old backups.
- `key create` prints only the public key to disk, in `~/.config/homectl/public-keys/`. The private key stays inside the database.
- A session lasts 24 hours from unlock by default. `--ttl until-reboot` keeps keys until you lock or the machine reboots. Unlocking again does not extend the session: the lifetime runs from the first unlock.
- With `home-ctl serve` running, `home-ctl session unlock` also unlocks the local synchronization vault, with one password prompt. Without it, unlock covers SSH only.

Unlock and lock:

```sh
home-ctl session unlock    # private terminal; the password is not echoed
home-ctl session status
home-ctl session lock
```

## Run the broker

The broker is the process that holds the vault and SSH keys and runs commands for agents. Start it before connecting an agent.

```sh
home-ctl start               # the broker and the owner panel, in one window; keep it open
home-ctl daemon status       # is the broker running?
```

`home-ctl start` opens the owner panel in your browser. Ctrl+C stops both. It sets the panel's address for you (the first free port from 7451).

- Only if you have no vault yet: `home-ctl owner init` sets the owner password, then the reviewer authority (Enter keeps recommend).
- If you created the vault with `setup` or `session init`, its vault password is the owner password, and `owner init` refuses to set another one. Signing in to the panel with it also opens the vault.
- The reviewer authority is only used once Auto Mode and a reviewer endpoint are set. `recommend` (the default) only recommends. Change it later with `home-ctl owner auto-mode set --authority routine|delegated`, which asks for the owner password.
- Without an owner password, `daemon run` starts but warns that approvals are impossible until you set one.
- `daemon run` prints where it listens. The address is also written to an endpoint file in the broker's state directory.

Advanced: run the broker and the panel separately. The broker refuses panel sign-in from any origin other than the one it was started with, so give both the same origin.

```sh
home-ctl daemon panel      # prints its origin, http://127.0.0.1:7451 by default (HOMECTL_OWNER_PANEL_PORT changes the port)
```

Set the origin the panel printed, then start the broker, in the same terminal:

```powershell
# PowerShell (Windows)
$env:HOMECTL_PANEL_ORIGIN = "http://127.0.0.1:7451"; home-ctl daemon run
```

```sh
# Bash, zsh, Git Bash
HOMECTL_PANEL_ORIGIN=http://127.0.0.1:7451 home-ctl daemon run
```

Hardened mode (Linux with systemd only) installs the broker as a service under its own account:

```sh
sudo home-ctl daemon install     # creates the homectl account and unit; if no vault exists, asks for the owner password and then the reviewer authority (Enter keeps recommend)
sudo home-ctl daemon uninstall
```

Installing shows the plan first when you add `--dry-run`. Every step runs as an argument list, not a shell command. Installing copies your workspace files into broker custody and leaves your originals in place; delete them yourself after you check the copy.

## Connect an agent

Connecting an agent creates a client identity, scopes it to the machines you name, and configures the agent to use the homectl MCP server.

```sh
home-ctl agent connect codex --hosts lab-printer
home-ctl agent connect claude --hosts lab-printer,nas-1 --name laptop
home-ctl agent connect other --hosts lab-printer
home-ctl agent connect claude --client claude --hosts lab-printer   # reconnect an existing assistant with a new key
```

`--client <id>` reconnects an assistant that already exists, for example the one the panel created. It rotates that assistant's key and writes its config, so no second assistant is created. The old key stops working.

What happens:

1. You enter the owner password. Creating a client requires it again.
2. homectl prints the exact change it plans to make, and says which file will hold the assistant's key, then asks `Apply these changes? [y/N]`. Nothing is created or changed until you answer yes. Without an interactive terminal it refuses and creates nothing.
3. If the default name is taken, including by an assistant you removed, homectl uses the next free name (`claude-2`) and says so. A removed assistant's name stays reserved: use `--name` for a new one, or reconnect with `--client`.
4. The agent's configuration receives the client token:
   - `codex`: a managed block in `~/.codex/config.toml`.
   - `claude`: `~/.claude/settings.json`, and the homectl MCP server entry in `~/.claude.json`.
   - `other`: only the private client-token file (`~/.config/homectl/client-token`, mode 0600), plus a setup prompt to paste into your agent.
5. homectl checks the new token against the broker before it reports success.

Then restart the agent. The MCP server runs `home-ctl mcp`, so `home-ctl` must be on the agent's PATH.

New clients get three scopes by default: `status:read`, `inspect:read` and `plan:create`. A client can reach only the hosts you list, and each host must already be in the inventory. Manage clients with:

```sh
home-ctl agent list
home-ctl agent rotate <id>      # new token; asks for the owner password
home-ctl agent revoke <id>      # stops that client's access
```

An agent asks for a change with `exec`. If the change needs your approval, the agent gets `awaiting-approval`, and you approve it in the panel or with `home-ctl approve <operation>`. The agent then runs `home-ctl wait <operation>`. See [security](security.md#approvals-and-auto-mode).

## Add a machine

### In the owner panel

Open the panel's **Machines** section, then **Add a machine**. The sheet has five steps:

1. **Name and access.** Give the machine a name (for example `nas`), its address, its SSH port and the login name homectl signs in as. Access starts at **Look only**. A root login is always **Full admin**.
2. **Key.** Run `home-ctl key create nas` in your private terminal, not in an assistant's chat. The panel waits for the key and shows its public part.
3. **Install.** Put the public key in the machine's keys file. The sheet gives the steps for Linux, UGOS (Personal Folder) and Proxmox. Check the path first.
4. **Identity.** Look at the machine's key, compare its fingerprint with the machine's own console, and type it. The panel moves on only when the two match exactly.
5. **Add.** Enter your owner password. homectl pins the key, saves the machine and runs one read-only check.

Then choose which assistants may reach it, in **Assistants**.

### In the terminal

1. Verify the machine's SSH host key through its console or provider panel. A scan alone does not establish trust.
2. Create its key: `home-ctl key create <name>`, then `home-ctl key inspect <name>`.
3. Install the **public** key through access you already have. Confirm the `authorized_keys` path and the account first, and keep your existing access in place.
4. Describe the machine in a JSON file outside the repository. Start from `examples/host.example.json`, and copy the `auth` references that `key inspect` printed.
5. Review, then enroll:

   ```sh
   home-ctl enroll <name> --file ./host.json --dry-run
   home-ctl enroll <name> --file ./host.json
   home-ctl doctor <name>
   ```

Enrollment checks SSH and the operating system before it saves a mode-0600 inventory entry. Pinning the host key in the broker and granting sudo are separate steps, described in [security](security.md#host-enrollment).

Access tiers (`observe`, `user`, `sudo-approved`, `full`) and their rules are in [security](security.md#host-access-tiers). A root account must use `full`.

Vendor notes:

- **UGREEN UGOS**: enable **Personal Folder** for the SSH account in the UGOS control panel before you install a key. Do not remove immutable protection from `/home`. <!-- verify: carried from the 0.2 guide. -->
- **Proxmox**: root's `authorized_keys` may be a symlink to cluster-managed storage. Keep the symlink, and review every node it affects before you add a key.

Proxmox VMs can be created over SSH with `home-ctl provision --file <vm.json> --dry-run`, starting from `examples/vm.example.json`. Provisioning needs an existing cloud-init template, and image import and cross-node provisioning are not implemented.

## Upgrade from 0.2

This section is written from the migration code in `src/migrate/`. It is **tested on fixtures only**: the migration tests run against synthetic 0.2 workspaces. It has **not been run on a real 0.2 install**. Preview your own workspace before you upgrade it.

### Preview and run

- `home-ctl migrate --dry-run` lists the steps that would run and the files each one may touch. It changes nothing.
- `home-ctl migrate` runs the migration. Starting the broker also migrates first: `daemon run` calls the same migration before it loads keys. The hardened service that `daemon install` writes runs `daemon run`, so it migrates at start too.
- A run takes a migration lock, copies each file the steps may touch into the workspace's `backups/` folder, runs and verifies each step in order, and checks that no other file changed. It writes the version marker (`homectl-data.json`) last.
- If anything fails, the backup is restored and the workspace stays at 0.2. An interrupted run is rolled back before the next run starts again from the backup. It is not resumed.
- Running it on current data changes nothing.

### What stays the same

These files are not changed. The migration checks that every file outside the declared set is byte-identical after the run, and fails and rolls back if one is not:

- `inventory.yaml`: accounts, tiers and session settings.
- `known_hosts`, including its `@revoked` lines, so a revoked host key stays revoked.
- The KeePassXC database (`homelab.kdbx`). The migration checks that it exists but never opens it.
- `public-keys/`.
- `peers.json`.
- `saved-commands.json` and `setup-preferences.json`.
- `control-plane/audit.jsonl` and `audit.anchor`, and `history/commands.jsonl`.

### What changes

- **Open operations are closed.** Pending and approved 0.2 operations become `failed`, and `executing` becomes `unknown`, all with the reason `retired-by-migration`. Their history is kept. The agent must plan them again.
- **Agent connections are kept.** Each client keeps its record, token digest, host grants and revocations. The `approve:decide` scope is removed from any client that had it. No client gains a scope or a host grant. The migration reports each dropped scope.
- **No `policy.json` is written.** The 0.3 default asks for changes that 0.2 ran without approval, so access narrows. The migration's own notes say which: 0.2 ran non-destructive changes without per-command approval on user, sudo-approved and full hosts, and `sudo_allow` commands on sudo-approved hosts; 0.3 asks the owner for these.

### What is not carried over

- **The 0.2 device signing key.** It is not copied. 0.3 creates its own device key on first start. The migration refuses to finish if the broker's key is a copy of the 0.2 key.
- **Replicated approval authority** (`control-plane/replica.json`). It is retired and kept as read-only evidence.
- **Sessions.** 0.2 session state is not restored. If the old session agent is still unlocked, lock it with `home-ctl session lock`. 0.3 unlocks with the owner's master password.
- **Pending approvals.** They are closed, not replayed (see above).

### Owner actions after upgrading

- **`home-ctl owner init`**, if the migration reports that no vault database was found. In 0.3 the vault's master password is the owner password.
- **`home-ctl agent connect codex|claude|other --hosts a,b`** for each agent whose MCP entry still points at the retired 0.2 control MCP (HTTP with a bearer token). The migration does not rewrite agent configuration. `agent connect` asks for the owner password, creates a new client with its own token, and writes the 0.3 configuration. Then remove the old 0.2 entry, and revoke the old client with `home-ctl agent revoke <id>` once nothing uses it.
- **`home-ctl setup`** to refresh the bundled agent skills to 0.3.
- **Hardened mode, state directory not writable.** The broker's state directory belongs to the service account. If a migration cannot write it, the run fails and rolls back, and nothing is changed. Fix the directory's ownership from an administrator terminal (with `sudo` on Linux), then run `home-ctl migrate --mode hardened` again. The hardened install itself needs root once: `daemon install` refuses to run without it.
- Run `home-ctl doctor` after the first start, and keep the 0.2 database until you have checked it.

### Other changes

- **Approvals.** `--approval <digest>` was removed in 0.3.0. Scripts that pass it fail with a message. Approve with `home-ctl approve <operation>` through the broker instead.
- **Peer sync.** The 0.2 pairing and sync commands (`pair`, `sync`, `peer`, `peers`) still exist. The new server and client workspace is described in [workspace](workspace.md).

## Platform notes

### Linux

- Packages and archives as above. Setup works the same way.
- **Compatibility broker**: `home-ctl daemon run`, as above.
- **Hardened broker**: `sudo home-ctl daemon install`. It requires systemd. Without it, the command explains the options and does nothing: enable systemd, use the container image, or stay in compatibility mode.
- **Background `serve`**: `home-ctl service install --interface <LAN-IP>` installs a systemd user unit that runs `home-ctl serve`, with `service start`, `stop`, `status`, `logs` and `uninstall`. A user service stops at logout unless lingering is enabled for that user, which homectl does not change. <!-- verify: the service starts with the vault locked and pairing closed; that statement is carried from the 0.2 peer guide and not found in src/service.ts. -->

### macOS

- Archives only in this build. The hardened broker is not available, so `daemon install` refuses and says to use compatibility mode.
- `home-ctl service install` installs a user LaunchAgent that runs `home-ctl serve` at login. It needs no root.
- Key preparation on macOS is manual in this build: import an Ed25519 key privately as the entry's attachment, create the matching public file, and add the auth references to the inventory. <!-- verify: carried from the 0.2 user guide; not re-tested on macOS. -->
- The macOS runtime has not been tested on a Mac. See [verification status](#verification-status).

### Windows

- Use the release zip, or a source checkout with `bun src/cli/main.ts setup`. Launchers go in `%USERPROFILE%\.local\bin`. Restart the terminal after the first setup. If PowerShell blocks the `.ps1` launcher, use `home-ctl.cmd` instead.
- **Compatibility broker only.** The hardened Windows service is not available in this build. The broker listens on a random loopback TCP port and writes it to its endpoint file.
- **Background operation** has two options:
  - `home-ctl service install --task --interface <LAN-IP>` creates a logon scheduled task that runs `home-ctl serve` for your user. It needs no service account password.
  - `home-ctl service install --wrapper <path to WinSW.exe> --interface <LAN-IP>` installs a Windows service through [WinSW](https://github.com/winsw/winsw), which you supply. homectl never downloads it. The service starts in **Manual** mode. Set its Log On account to your Windows user in `services.msc`, and enter the password there, never in a command. The CLI refuses to run the service as SYSTEM.
- Run `service install` from an elevated terminal, as the 0.2 Windows guide describes. <!-- verify: elevation requirement is not checked in this file. -->
- Sessions use a dedicated OpenSSH agent on a named pipe for each inventory, not the shared Windows SSH agent. Private files get owner and SYSTEM-only NTFS permissions, and homectl refuses symlinked private folders and paths owned by another account.
- Windows named pipes, the private-file permissions and the service account are not verified on real Windows hardware yet. Test them yourself before you rely on them.

### Docker and NAS containers

- `Dockerfile` builds the 0.3 broker image. Pass a digest-pinned base image with `--build-arg BUN_IMAGE=oven/bun@sha256:<digest>`. There is no default, on purpose. The image installs `openssh-client` and `keepassxc`, and runs as a non-root user (uid 10001). Example: `docker build --build-arg BUN_IMAGE=oven/bun@sha256:<digest> -t homectl-broker:0.3-local .`
- With no arguments, the container runs the broker (`daemon run`) and the owner panel (`daemon panel`) together, from `docker/entrypoint.ts`. If either one stops, the container stops with an error. `docker stop` stops both cleanly.
- With arguments, the container runs `home-ctl` with them, for example `owner init`, `daemon status`, or the legacy `serve --container --interface <LAN-IP> --no-discovery` peer.
- On first start the entrypoint creates an empty `inventory.yaml` (owner-only) in `/data/home/.config/homectl/`, because the broker refuses to start without one. An existing file is never changed.
- The image's health check (`docker/healthcheck.ts`) passes when the broker answers on its endpoint and the owner panel answers `/healthz` on loopback. For the legacy `serve` command it passes when its `/healthz` reports `ok`.
- UGOS Docker Compose project: `examples/container/compose.broker.yaml`. It keeps state in one private named volume at `/data`, uses a read-only root filesystem, drops all capabilities, sets `no-new-privileges`, and contains no secret. It uses a bridge network and publishes the panel on `127.0.0.1:7451` of the NAS by default (`HOMECTL_PANEL_PUBLISH` changes it). Inside the container the panel listens on `0.0.0.0` (`HOMECTL_PANEL_LISTEN`), so `HOMECTL_PANEL_ORIGIN` is required. Put the exact browser origin in the project's `.env`; the example name `homectl.lan.example.test` is a placeholder. Compose stops when it is missing. There are two supported ways to reach the panel:
  - an `https` reverse proxy you run, forwarding to the published port, with `HOMECTL_PANEL_ORIGIN` set to the `https` origin your browser opens. The proxy must pass the `Host` and `Origin` headers through unchanged.
  - an SSH tunnel, `ssh -L 7451:127.0.0.1:7451 <nas>`, with `HOMECTL_PANEL_ORIGIN=http://127.0.0.1:7451` and `HOMECTL_PANEL_INSECURE_HTTP=1`. SSH encrypts the traffic, but the panel sees plain http. Without the opt-in the panel refuses to start on a non-loopback address.

  Plain http on a LAN address is refused by default. With `HOMECTL_PANEL_INSECURE_HTTP=1` the owner password and session cookie cross the LAN in clear text, so prefer the proxy or the tunnel. The workspace port is not published by the base project. Only the NAS that is the workspace server adds `examples/container/compose.workspace.yaml` (`docker compose -f compose.broker.yaml -f compose.workspace.yaml up -d`), which sets the listener to `0.0.0.0:7450` and publishes it on `HOMECTL_WORKSPACE_PUBLISH` (default `127.0.0.1:7450`, reachable from the NAS only; set the NAS's LAN address for clients). UGOS imports one compose file, so there the override must be merged into the project by hand.

- Set the owner password inside the container, in a private terminal, with `docker exec -it homectl-broker bun /app/src/cli/main.ts owner init`. Never put it in a compose file or an environment variable.
- Older examples `examples/container/compose.example.yaml` and `compose.project.yaml` run the 0.2 `serve --container` peer. They still work with this image, because the entrypoint passes their command through. They publish the peer port (7448) on an address you set, and the panel (7447) only on a loopback or LAN address you choose.
- Keep keys, the inventory and backups in the `/data` volume. Do not bake them into the image.
- The `container.yml` workflow builds the image and smoke-tests it with `scripts/container-smoke.sh`, which starts `serve --container` and waits for it to be healthy. That path still passes. The workflow does not yet test the default broker command.
- **Container verification.** On a local Docker Desktop (Windows host) on 2026-11-20, with the base image `oven/bun:1.4.5-debian` pinned by digest (`oven/bun@sha256:3dddea58…`, which reports Bun 1.4.5): the image builds, and `scripts/container-smoke.sh` passes both the default command (broker and owner panel become healthy) and `serve --container`. An earlier check on the previous Bun 1.4.4 digest also confirmed the owner panel `/healthz`, `daemon status`, a clean `docker stop`, a restart that keeps the inventory, and a valid and an invalid `HOMECTL_WORKSPACE_LISTEN`; those were not re-run on 1.4.5. Not verified: UGOS itself, host networking on UGOS, a real NAS, the SSH tunnel to the panel, interactive `owner init` inside the container, and backup and restore from the container.
- **Bridge-network check (2026-11-20, local Docker Desktop, Linux engine).** The image built from the `Dockerfile` with `BUN_IMAGE=oven/bun:1.4.5-debian`, a tag and not a digest, and the compose project ran on its bridge network with the panel published on loopback. The panel answered `/healthz`. A request whose `Host` and `Origin` matched `HOMECTL_PANEL_ORIGIN` reached the broker. A foreign `Origin`, a missing `Origin` and a wrong `Host` were refused with 403. Login set `HttpOnly; SameSite=Strict; Max-Age=900; Secure`, and logout cleared it with the same attributes. A non-loopback plain-http origin without the opt-in exited with status 2, and so did a non-loopback listen address without an origin. The owner password for this check was a throwaway value set inside a disposable container, not through `owner init`. Not verified: a real browser, UGOS, a reverse proxy, the SSH tunnel.
- **Ugreen UGOS**: create Docker Compose projects from the UGOS app. Before an SSH key can be installed for a user on UGOS, enable **Personal Folder** for that account. <!-- verify: carried from the 0.2 user guide; not re-tested on UGOS. -->

### WSL

- WSL is a separate Linux installation with its own inventory, vault and session. Pair it as its own device if you want to sync it.
- `service install` and the hardened broker use systemd **inside** the distribution. Enable it in `/etc/wsl.conf` (`[boot] systemd=true`).
- NAT networking can block LAN multicast and inbound pairing. Use mirrored networking, or set up host networking and a manual address.
- homectl does not change `.wslconfig`, Windows firewall rules or port forwarding.

## Verification status

What the repository checks automatically (`.github/workflows`):

- **Linux CI**: typecheck, lint (including the file-length and doc-link checks), the full test suite, and browser UI tests.
- **Windows CI**: typecheck, lint, a subset of the tests, and PowerShell, CMD and Git Bash smoke tests.
- **Release**: Linux packages installed in clean containers, with `home-ctl help` run in each.

- **macOS CI** checks the compiled binary on a runner. LaunchAgent behavior on physical hardware remains unverified.
- **WSL2** smoke on Arch Linux (2026-11-23) ran a compiled Linux x64 candidate with a disposable inventory. The broker's Unix socket required a client token and the embedded owner panel served on loopback.

Not verified yet:

- Windows named pipes, file ACLs, the WinSW service and WSL networking on real hardware.
- Two real devices that pair, sync and operate each other over a LAN.
