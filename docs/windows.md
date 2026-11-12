# Windows, PowerShell, CMD, Git Bash and WSL

[← Back to the user guide](user-guide.md)

On native Windows, PowerShell, CMD and Git Bash share one installation in `%USERPROFILE%\.config\homectl`. WSL is a Linux installation with its own inventory, vault and session.

## What you need

- **Bun 1.4.4+** and **KeePassXC**, from their official installers.
- The Windows **OpenSSH Client** optional feature. homectl uses `%SystemRoot%\System32\OpenSSH\ssh.exe`, even when Git Bash puts a different `ssh` first on PATH.
- The release zip from the [README](../README.md#install), or a source checkout. Setup works from either. The skills are built into `home-ctl.exe`.

## Install

From the release zip, in PowerShell:

```powershell
home-ctl.exe setup
```

From a source checkout (Bun 1.4.4+), in PowerShell:

```powershell
bun install --frozen-lockfile
bun src/cli/main.ts setup
```

- `setup --install-deps` installs a missing OpenSSH Client (it asks for admin rights) and KeePassXC (through winget). Preview with `--dry-run`.
- Plain `setup` asks before it installs anything or changes firewall rules.
- Firewall rules cover only Bun, UDP 5353 and TCP 7448, on the subnet you select and the Private profile. No network profile is changed.

Setup creates three launchers in `%USERPROFILE%\.local\bin`:

- `home-ctl.cmd` for CMD
- `home-ctl.ps1` for PowerShell
- `home-ctl` for Git Bash

It adds that folder to your user PATH. Restart your terminal app (Windows Terminal, VS Code) to pick it up. For the current PowerShell only, run `$env:Path = "$HOME\.local\bin;$env:Path"`. If PowerShell scripts are blocked, use `home-ctl.cmd`. homectl never changes your execution policy.

Skills are copied, so setup does not need Developer Mode or admin rights for symlinks. Existing launchers and skills that differ are never overwritten.

### Update

```powershell
home-ctl.cmd update --dry-run
home-ctl.cmd update
```

For a source checkout, the update needs a configured upstream. It fast-forwards only, keeps unrelated local changes, reinstalls the frozen dependencies and reruns setup. Your inventory and vault stay as they are, and running services are not restarted. If your checkout predates this command, run `git pull --ff-only` once first.

## Start

```powershell
home-ctl.cmd session init
home-ctl.cmd panel
```

`panel` starts a temporary workspace and uses the LAN address you picked during setup. Keep that terminal open while you use it. For background operation, install the service below.

Enter passwords in a Windows console terminal. Private prompts run through PowerShell. In older mintty terminals, run the unlock step from PowerShell or CMD instead.

Windows keys live in a dedicated OpenSSH agent on a named pipe for this inventory, not in the shared Windows SSH agent. Locking clears keys from that agent only. Private files get an owner and SYSTEM-only NTFS ACL. homectl refuses symlinked private folders and paths owned by another account.

To pair devices and sync, see the [sync guide](peer-workspace.md).

## Run as a Windows service

Bun alone cannot run as a Windows service. homectl uses [WinSW](https://github.com/winsw/winsw), which you supply. homectl never downloads and runs a wrapper on its own.

From an **elevated, private** terminal:

```powershell
home-ctl.cmd service install --interface 192.168.1.20 --wrapper C:\Tools\WinSW.exe
```

The service starts with **Manual** startup. Before you start it:

1. Open `services.msc` and select **homectl peer workspace**.
2. Under **Log On**, choose the Windows user that owns your homectl files, and enter its password in the Windows dialog. Do not put the password in command arguments, XML, repository files or chat.
3. Do not run it as SYSTEM. The CLI refuses to start or restart a SYSTEM service.

```powershell
home-ctl.cmd service start
home-ctl.cmd service status
home-ctl.cmd service logs
home-ctl.cmd service stop
home-ctl.cmd service uninstall
```

The service starts with keys locked and pairing closed. Set automatic startup in the service manager, if you want it, after the account is set up. `service uninstall` removes the service registration only. Your vault, inventory and device trust stay. Installing or removing the service needs Windows admin rights. A normal `serve` or `panel` does not.

## WSL

Install the Linux prerequisites inside WSL, then run Linux `setup`. Keep WSL's inventory separate from the Windows one, and pair WSL as its own device when you want to sync.

- `service install` uses systemd **inside** the distribution, so enable systemd there first.
- Starting the WSL distribution at Windows boot is a separate host setting. Installing the systemd unit does not do it.
- NAT networking can block LAN multicast and inbound pairing. Use mirrored networking, or set up host networking and a manual IP.
- homectl does not change `.wslconfig`, firewalls or port forwarding.

## Verification status

The repository's Windows CI job runs typecheck, lint, a subset of the tests, and PowerShell, CMD and Git Bash smoke tests. It does not prove named-pipe behavior, ACL enforcement, service account setup or WSL networking on your computer. Before you rely on those, run the service setup and a two-computer LAN check yourself.
