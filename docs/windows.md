# Windows, PowerShell, CMD, Git Bash and WSL

Native Windows uses Bun, Windows OpenSSH and KeePassXC. PowerShell, CMD and Git Bash share `%USERPROFILE%\.config\homectl` and one native peer identity. WSL is a Linux installation with its own inventory, vault, session and peer identity.

## Native prerequisites

Install Bun 1.4.2+ and KeePassXC from their official distributions. Enable the Windows **OpenSSH Client** optional feature. Homectl selects `%SystemRoot%\System32\OpenSSH\ssh.exe` even when Git Bash puts Git's different SSH implementation first on PATH. KeePassXC CLI is discovered from PATH or its default `Program Files\KeePassXC` installation. PowerShell is used for private password entry and NTFS ACL management.

From the checkout:

```powershell
bun install --frozen-lockfile
bun src/cli/main.ts setup
```

`--install-deps` installs missing Windows OpenSSH Client through a UAC elevation prompt and KeePassXC through Microsoft winget. Install Microsoft App Installer if winget is unavailable. Existing dependencies are left in place; no vault is opened or initialized. Preview with `setup --install-deps --dry-run`. Bun is required to run this command. Plain `setup` in an interactive terminal asks before installing missing dependencies and configuring firewall rules. It saves the selected LAN for future `pair` commands. Windows firewall rules are limited to Bun, UDP 5353/TCP 7448, the selected subnet and the Private profile. No network profile is changed. `setup --json` never prompts or opens UAC; explicit `--install-deps` and `--configure-firewall --interface <IP>` require an already elevated terminal.

Setup produces three launchers under `%USERPROFILE%\.local\bin`:

- `homectl.cmd` for CMD (and ordinary command resolution).
- `homectl.ps1` for PowerShell.
- `homectl` for Git Bash, using `cygpath` to locate the same Bun executable.

Setup adds that directory to your Windows user PATH idempotently. Restart the entire terminal application (including Windows Terminal or VS Code) to load the updated environment. For immediate use in the current PowerShell, run `$env:Path = "$HOME\.local\bin;$env:Path"`. If PowerShell script execution is restricted, invoke `homectl.cmd`; homectl does not change execution policy. Skills are copied on Windows so setup does not require Developer Mode or elevated symlink rights. Existing different launchers and skills are not silently overwritten.

Update the installed checkout with `homectl.cmd update` (or preview with `homectl.cmd update --dry-run`). It requires a configured upstream and preserves unrelated local changes, uses fast-forward only, installs the frozen dependencies and reruns setup. It preserves the per-user inventory and vault and does not restart running services. If your checkout predates this command, use `git pull --ff-only` once first.

Initialize or import credentials locally, then start the workspace:

```powershell
homectl.cmd session init
homectl.cmd serve --interface 192.168.1.20
# Separate private terminal:
homectl.cmd panel
```

To reuse the existing Linux access, pair devices and sync from the workspace as described in [peer workspace](peer-workspace.md). You do not need to alter the servers when copying the same SSH keys. Both vaults must be unlocked locally for credential transfer; the destination vault has its own password.

Windows uses a dedicated Ed25519 agent on an inventory-specific named pipe, rather than the user's shared Windows SSH-agent service. Lock does not call `ssh-add -D` against the personal agent. TTL and explicit lock clear the dedicated process's keys; restart does not restore them. Files and directories use a private owner/SYSTEM NTFS DACL; homectl refuses symlinked private directories or paths owned by another account. New key attachment staging contains encrypted PKCS8, never an unencrypted private key. Existing unencrypted Ed25519 OpenSSH attachments inside KDBX remain readable.

Private credential prompts are invoked through PowerShell. Use a Windows console terminal for credential entry; legacy mintty environments without an interactive Windows console may require running the private unlock step from PowerShell/CMD. Subsequent CLI operations and the local panel use the same native configuration in all three shells.

## Windows service

Bun alone is not a Windows Service Control Manager host. Homectl uses an official [WinSW](https://github.com/winsw/winsw) executable supplied by you; it never downloads and runs an unverified wrapper automatically.

From an elevated **private** terminal:

```powershell
homectl.cmd service install --interface 192.168.1.20 --wrapper C:\Tools\WinSW.exe
```

The registration initially uses **Manual** startup. Before starting, open `services.msc`, select **homectl peer workspace**, and configure **Log On** with the same Windows user that owns your homectl files. Enter that account's password in the Windows service dialog, not in command arguments, XML, repository files or chat. Do not leave it running as SYSTEM; the CLI refuses to start/restart a SYSTEM service.

```powershell
homectl.cmd service start
homectl.cmd service status
homectl.cmd service logs
homectl.cmd service stop
homectl.cmd service uninstall
```

Choose automatic startup in the service manager if desired after account setup. The service starts with locked keys and pairing closed. `service uninstall` removes its host/configuration but preserves the vault, inventory and trust. Installing or removing a native service requires Windows administrator privileges; ordinary temporary `serve` does not.

## WSL

Install the Linux prerequisites inside WSL and run Linux `setup`. Do not point Linux session sockets at the native Windows inventory. Pair the WSL installation as a separate peer when you want to synchronize it.

`service install` uses systemd **inside** the distribution. Ensure that distribution has systemd enabled. Starting the WSL distribution itself at Windows boot is a separate host setting; installing a systemd unit does not make that happen. NAT-based WSL networking can block LAN multicast and inbound pairing. Use supported mirrored networking where configured, or an explicit host networking arrangement and manual IP. Homectl does not modify `.wslconfig`, firewalls or port forwarding.

## Verification status

The repository includes a Windows CI job for typechecking, lint, synthetic peer/agent tests and PowerShell/CMD/Git Bash CLI smoke. Linux local tests and Chromium UI tests do not prove Win32 named-pipe interoperability, Windows ACL enforcement, Windows service account setup or WSL networking on your computer. Run the Windows job and an actual two-computer LAN check before treating those paths as verified in your environment.
