# homectl

**Let an AI coding agent work on your homelab machines, without giving it your SSH keys.**

homectl runs a local broker that holds the keys in an encrypted vault and runs commands for agents such as Codex or Claude Code. You decide what needs your approval, and an agent never sees a password.

The command is `home-ctl`.

- [Setup](docs/setup.md): install, first run, connecting agents and machines, platform notes
- [Security](docs/security.md): trust boundaries, approvals, secrets, host enrollment, backup custody, residual risks
- [Workspace](docs/workspace.md): the optional server mode, pairing, mirrored approvals, offline behaviour, backups
- [Reference](docs/reference.md): commands, MCP tools, paths, exit codes, troubleshooting

## What it does

- **The broker holds the keys.** `home-ctl start` (the broker and the owner panel) owns the vault and the SSH agent. Each agent gets its own client token and reaches only the machines you name.
- **Machines have an access tier.** `observe`, `user`, `sudo-approved` or `full`. A tier describes what the agent may run; your accounts still set the real privileges. See [security](docs/security.md#host-access-tiers).
- **Changes wait for you.** A command that needs approval returns `awaiting-approval`. You approve it in the owner panel or with `home-ctl approve <operation>`, and the agent then waits for the result.
- **Secrets stay out of chat.** An agent asks for a secret for one destination. You provide it in the panel, and the broker injects it and redacts it from the output.
- **An optional server.** One broker can act as a workspace server. It mirrors approvals and events from linked clients and stores encrypted backups it cannot read. Clients keep working without it.

## Requirements

- OpenSSH client (`ssh`) and the KeePassXC CLI (`keepassxc-cli`). `home-ctl setup` checks for both.
- Bun 1.4.5 or newer, only if you run from a source checkout.
- systemd, only for the hardened broker on Linux.

Windows and macOS run the compatibility broker, which runs as your user. Details are in [setup](docs/setup.md#platform-notes).

## Install

| System                                     | How                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Debian, Ubuntu, Fedora, RHEL, Arch, Alpine | Install the package from the latest [release](https://github.com/Hiosdra/homectl/releases/latest).                                           |
| macOS, Linux                               | Unpack the archive for your system and put `home-ctl` on your PATH.                                                                          |
| Windows                                    | Unzip `homectl-<version>-windows-x64.zip` and run `home-ctl.exe setup`.                                                                      |
| Source checkout                            | `git clone https://github.com/Hiosdra/homectl.git`, then run `bun install --frozen-lockfile` and `bun src/cli/main.ts setup` in that folder. |

Then run setup once for your user:

```sh
home-ctl setup --dry-run   # shows what will change
home-ctl setup
```

Setup creates the inventory, the launchers, the SSH include and the agent skills. Full details, including the packages for each system, are in [setup](docs/setup.md#install).

<!-- verify: Homebrew (brew tap Hiosdra/tap) was listed in earlier docs, but no Homebrew step exists in .github/workflows/release.yml. Add it back only after confirming the tap. -->

## Quick start

```sh
# In a private terminal, once. The guided setup checks the tools, creates your
# vault and asks for its password. That password is also your owner password.
home-ctl setup
home-ctl key create lab-printer            # creates the machine's key in the vault
home-ctl key inspect lab-printer           # install this public key through access you already have

# After you verify the host key through a trusted source:
home-ctl enroll lab-printer --file ./lab-printer.json --dry-run
home-ctl enroll lab-printer --file ./lab-printer.json

# Start homectl: the broker and the owner panel in one window (setup offers this too).
# It opens the panel in your browser, on the guided setup until it is complete.
# Keep the window open; Ctrl+C stops it.
home-ctl start

# Connect your agent (or use the panel's Assistants page):
home-ctl agent connect codex --hosts lab-printer
```

Then ask your agent to work on the machine:

> Check the printer's Klipper and Moonraker services before changing anything.

> Inspect the NAS disk usage and summarize what is taking space.

The full walkthrough, with the host-key checks and platform steps, is in [setup](docs/setup.md).

Upgrading from 0.2 migrates the workspace data when the broker starts. `home-ctl migrate --dry-run` previews that migration, and `home-ctl migrate` runs it without starting the broker. See [upgrade](docs/setup.md#upgrade-from-02). The container image runs the broker and its owner panel; see [Docker and NAS containers](docs/setup.md#docker-and-nas-containers).

## Approvals

Safe reads run without a prompt. Anything that changes state waits for your decision:

```sh
home-ctl approvals                          # what is waiting
home-ctl approve <operation>                # or: home-ctl deny <operation>
home-ctl approve <operation> --remember     # also saves an exact rule for this one command
```

Significant (R3) and destructive (R4) actions, and trust changes, ask you, and the decision needs your owner password again. Budgets, Auto Mode and rules are described in [security](docs/security.md#approvals-and-auto-mode).

## Honest limits

- **Approval is a safeguard, not a sandbox.** An approved command runs with the privileges its account already has.
- **Compatibility mode shares your user.** Any program running as you can use the unlocked SSH agent. Lock the session when you finish, and use the hardened broker on Linux when you can.
- **The owner password can open the vault.** When a vault exists, the two are the same password.
- **Early project.** Image import, DHCP discovery, cross-node Proxmox provisioning and the workspace backup commands are not finished. The Windows and macOS runtimes are not verified on real hardware. [Setup](docs/setup.md#verification-status) lists what is and is not verified.

## Agent skills

The skills in `skills/` teach agents how to operate, set up and enroll machines:

- [homelab](skills/homelab/SKILL.md): operate machines and deploy Ugreen NAS projects
- [homelab-setup](skills/homelab-setup/SKILL.md): bootstrap and diagnose homectl on this computer
- [homelab-enroll](skills/homelab-enroll/SKILL.md): add existing machines or create Proxmox VMs

## Development

```sh
bun install --frozen-lockfile   # also points git at .githooks
bun run verify     # bun check, lint (file length, doc links, biome, bun fmt), non-TS lint, tests
bun run format     # biome fixes, then bun fmt
```

The pre-commit hook (`.githooks/pre-commit`) runs `bun fmt --staged`, `bun check`, the file-length and doc-link checks, biome on staged sources, and `scripts/lint-other.sh` when shell scripts, workflows or the Dockerfile are staged. Non-TS lint uses local shellcheck, actionlint and hadolint, or their pinned Docker images.

Keep the documentation in `docs/` in step with the code. Maintainer build steps are in [reference](docs/reference.md#building-from-source).

## License

MIT. See [LICENSE](LICENSE).
