# agentic-homelab

Manage local and SSH machines from Codex or Claude Code using existing users, Bitwarden, explicit access tiers, and a shared TypeScript/Bun CLI. Create focused Proxmox VMs from prepared cloud-init templates. This is a personal homelab tool: **full/root access is supported intentionally**, while **every destructive operation requires explicit human confirmation**.

Automated checks use local processes and fake SSH/API providers; they do not validate a particular network or credential-provider state. `homectl doctor <host>` checks current host connectivity. Proxmox VM provisioning uses a separate API path and still needs first-use validation against the node's API viewer and a reviewed VM plan.

## TL;DR — first-time setup

Do this **on the Linux/macOS machine where Codex or Claude Code runs**, using your existing account. Have Bun 1.4.2+, Git and OpenSSH installed. On Windows, use a Linux/WSL environment.

**1. Install the CLI and all three skills.** Keep this checkout in a permanent location.

```sh
git clone https://github.com/Hiosdra/agentic-homelab.git
cd agentic-homelab
bun install --frozen-lockfile
bun src/cli/main.ts setup --dry-run
bun src/cli/main.ts setup
export PATH="$HOME/.local/bin:$PATH"
homectl doctor
```

Add that PATH entry to your shell profile for future terminals. Setup links skills for both agents; it does not install additional Codex/Claude instances.

**2. Choose authentication for your first host.**

| Your host uses | What you configure once |
|---|---|
| SSH key in Bitwarden | Enable Bitwarden Desktop SSH Agent, set its socket, and select `bitwarden-ssh-agent` |
| Key already loaded in ssh-agent | Select `local-ssh-agent` |
| SSH password only | Install/pair AAC privately, then select `bitwarden-agent-access` with the vault `item_id` |

For password/AAC setup, follow [Bitwarden and secret boundaries](#bitwarden-and-secret-boundaries). Never paste passwords, private keys or pairing tokens into the agent chat or inventory.

**3. Add your first existing machine.**

```sh
cp examples/host.example.json "$HOME/.config/homectl/first-host.json"
```

Edit that file: replace the example address, SSH alias, existing username, description and auth backend. Choose `observe`, `user`, `sudo-approved` or `full`; use `enforcement: advisory` unless you have actually configured/reviewed sudoers. The sample selects **full**—choose the tier you intend. For `sudo-approved`, add exact `sudo_allow` entries.

In your own trusted terminal, establish the host's verified SSH fingerprint in `known_hosts` before enrollment. Then, from the checkout:

```sh
homectl enroll first-host --file "$HOME/.config/homectl/first-host.json" --dry-run
homectl enroll first-host --file "$HOME/.config/homectl/first-host.json"
homectl doctor first-host
homectl exec first-host -- uname -s
```

For a full non-root account, configure the existing user's NOPASSWD sudo using [Existing-user sudo](#existing-user-sudo). A root SSH account already has root authority and needs no sudoers rule. Selecting `full` alone does not grant Unix privileges.

**4. Start using the agent.** Ask it to use `homelab` to inspect `first-host`. Local inventory is in `~/.config/homectl/inventory.yaml`; Proxmox provisioning is an optional [next step](#provision-a-proxmox-vm). Every destructive operation still needs your explicit confirmation, including on full hosts.

## Start on the machine running the agent

Requirements: Linux/macOS, Bun 1.4.2+, OpenSSH, and an existing Unix user. Windows CLI setup/transport is not implemented; use Linux/WSL or a VM. Keep the checkout at a stable path because launchers and skill links refer to it.

```sh
git clone https://github.com/Hiosdra/agentic-homelab.git
cd agentic-homelab
bun install --frozen-lockfile
bun src/cli/main.ts setup --dry-run
bun src/cli/main.ts setup
export PATH="$HOME/.local/bin:$PATH"
homectl doctor --json
```

Setup creates `~/.config/homectl/inventory.yaml`, a generated SSH config and an additive Include in `~/.ssh/config`. It installs a launcher and links the **same three skills** into Codex's `~/.agents/skills` and Claude Code's `~/.claude/skills`. Conflicting existing paths are refused, not replaced. No permission settings are weakened, no new coding agent is installed, and no additional remote accounts are required. If the agent host itself runs as root, setup explicitly records full for the local host and adds a caution; it does not pretend a root account can be user/observe isolated.

Agent skills:

| Skill | Responsibility |
|---|---|
| `homelab-setup` | Bootstrap CLI, adapters, credential tools, aliases and diagnostics |
| `homelab` | Daily inspection, troubleshooting, updates and service operations |
| `homelab-enroll` | Adopt existing machines or create/enroll Proxmox VMs |

Skills remain thin; policy, plans, validation, credential routing and execution live in `src/`. See [architecture](docs/architecture.md) and [official sources](docs/research.md).

## Inventory and access tiers

Use [examples/inventory.example.yaml](examples/inventory.example.yaml). All addresses are documentation examples. Inventory is strict YAML with a [JSON Schema](schema/inventory.schema.json); unknown fields, obvious secret fields, duplicate aliases and invalid SSH values fail validation. Store **references**, never passwords, private keys, master credentials, recovery codes or API token secrets.

```yaml
version: 1
machines:
  agent-host:
    description: Machine running the current agent
    transport: local
    access: user
    enforcement: advisory
  lab-printer:
    description: Example Klipper printer
    transport: ssh
    ssh_alias: lab-printer
    address: 192.0.2.10
    user: pi
    access: full
    enforcement: sudoers
    auth:
      type: bitwarden-ssh-agent
    caution:
      - Check printer is idle before restarting Klipper
```

The address/user/port live in inventory; homectl regenerates aliases before exec and doctor. Once setup adds the Include, ordinary `ssh lab-printer` also resolves the alias. Machine operations by an agent should still go through homectl, because raw SSH bypasses its workflow checks. For a custom `--inventory /path/inventory.yaml`, the generated config is `/path/inventory.yaml.ssh_config`; direct SSH uses `ssh -F /path/inventory.yaml.ssh_config lab-printer`.

| Tier | homectl policy | Actual system boundary |
|---|---|---|
| observe | Conservative supported inspection grammar; no intentional mutation or sudo | Advisory unless account/OS independently restricts writes |
| user | Arbitrary user commands; direct sudo/escalation rejected | Existing Unix user's real rights |
| sudo-approved | User commands plus exact `sudo -n` argv in `sudo_allow` | Limited sudoers, if correctly installed and no broader grants remain |
| full | Arbitrary commands and root/sudo; NOPASSWD: ALL supported | Existing account/root authority, deliberately permissive |

Destructive confirmation applies to **all tiers**. `enforcement: sudoers` declares an administrator's configuration, not proof that all pre-existing group/polkit/sudo grants were removed. The CLI does not silently downgrade full or reset account privileges. Existing root SSH accounts are supported only with full. Non-full local execution refuses to run as Unix root.

## Bitwarden and secret boundaries

Choose a backend per SSH host:

- **bitwarden-ssh-agent**: enable the SSH Agent in Bitwarden Desktop. OpenSSH uses its socket, and homectl never obtains private-key bytes. Linux/macOS socket paths vary by package; use the official guide and set `SSH_AUTH_SOCK`, or `auth.socket` to the actual path. Unlock/key authorization can require a desktop GUI; do not use this as the only headless authorization path.
- **local-ssh-agent**: existing OpenSSH agent, useful on a headless host. Load keys privately; homectl does not retrieve or write them. Agent socket availability is not equivalent to having the correct key loaded.
- **bitwarden-agent-access**: `auth.item_id` references a Bitwarden vault login item. For SSH, its password field is injected into a private child through the official `aac run --id ... --env NAME=password -- ...` mechanism. The account name comes from inventory. For Proxmox, the password field stores the API token **secret**; token ID is public metadata in inventory.

Agent Access is **early preview**. This project uses its documented CLI rather than inventing a Node SDK integration. A narrowly scoped Bun worker bridges password injection to OpenSSH `SSH_ASKPASS`, which the documented AAC mechanism does not provide by itself. The helper's stdout goes only to OpenSSH; never invoke it from an agent. SSH cannot hang for an interactive password; prompts/timeouts are bounded. No sshpass argument, secret JSON retrieval, `--env-all`, shell tracing or secret-literal command is used.

The worker redacts the injected value (including common encodings), labelled credentials and private-key blocks before releasing output to the outer CLI. The outer CLI starts children with a limited environment. Redaction is defense in depth: arbitrary application/config/log output can contain **other** secrets unknown to homectl. Do not request secret-bearing files or intentionally dump credentials. A malicious process with the same Unix UID/root can read environment/memory; full is not an isolation boundary. Protect the agent host and trusted tool binaries.

Install components if needed:

```sh
homectl setup --install-bitwarden-cli
# Add ~/.config/homectl/node_modules/.bin to PATH for the bw provider.
# For AAC, obtain a pinned release and independently verify its archive SHA256:
homectl setup --aac-version <release-tag> --aac-sha256 <verified-archive-sha256>
```

AAC installer supports researched Linux x86_64 and macOS x86_64/arm64 assets; Linux arm64 is not assumed supported. Existing binaries are not overwritten. Official manual installation is documented at [bitwarden/agent-access](https://github.com/bitwarden/agent-access). The checksum option intentionally has no guessed default.

**One-time private setup:** on the credential-provider device, the user runs `aac listen`, unlocks it with `/unlock` in the trusted terminal, and pairs the client using the current official instructions. Unlocking and approving each request are separate. A temporary accept-all window can expire, and `bw status` does not establish whether the AAC listener is unlocked or ready. Keep pairing tokens, vault master password and session state outside the model transcript, shell history, shell startup files and repository; do not put `BW_SESSION` in `.zshrc`. If AAC's reusable pairing option is used, it persists a token on disk and requires an explicit choice. If a pairing code/token is shared in chat, treat it as exposed and regenerate it. `homectl doctor` checks `aac run --help` syntax; a host probe then verifies auth without printing secrets. Pairing and any credential/session caching/revocation are controlled by AAC/provider, not homectl. No unattended authorization or cache lifetime is promised. Keep the provider available/unlocked as required. The implementation never runs `aac connect --output json`.

Commands execute on the Codex/Claude host. A phone or other remote client only controls/approves that session; SSH/API secrets are not routed through that remote-control client. Desktop-only Bitwarden dialogs can still require access to the provider desktop. Headless clients can use AAC or local ssh-agent, subject to provider authorization.

## Adopt an existing machine

Copy/adapt [examples/host.example.json](examples/host.example.json) outside this repository. Existing accounts, including printer appliance users, work without creating an agent account.

```sh
homectl enroll lab-printer --file /path/host.json --dry-run --json
homectl enroll lab-printer --file /path/host.json
homectl doctor lab-printer --json
```

Before first access, verify the host-key fingerprint through a trusted console/known source and establish `known_hosts` on the agent host. OpenSSH uses `StrictHostKeyChecking=yes`; homectl never accepts an unverified key or disables checks. Initial user access once may be necessary. Password-only devices can use an Agent Access item reference after pairing.

Enrollment validates before modifying inventory, probes `uname -s`, generates the alias and saves a mode-0600 inventory atomically. It refuses conflicting existing entries. Run inventory-changing operations sequentially; concurrent enrollment is not a supported transaction model. Failed enrollment does not change inventory, though it may refresh the generated SSH config. The probe strips AAC log lines from the reported OS value and gives specific, secret-safe remediation for AAC waits, SSH authentication, host-key rejection and network failures. Resolve the reported cause before retrying; do not repeat long credential waits blindly.

### Existing-user sudo

Full deliberately permits:

```sudoers
existinguser ALL=(ALL:ALL) NOPASSWD: ALL
```

For sudo-approved, configure literal absolute argv lists:

```yaml
sudo_allow:
  - [/usr/bin/systemctl, restart, moonraker]
  - [/usr/bin/systemctl, status, moonraker, --no-pager]
```

Print a policy with `homectl sudoers lab-printer`, validate using `visudo -cf`, then install through existing trusted bootstrap access. `homectl enroll ... --configure-sudo` performs that installation only when the existing user can already run the bootstrap command via noninteractive sudo. It refuses to overwrite a different policy. If bootstrap sudo needs a password, the user applies it in a private interactive terminal; the agent does not learn the sudo password. Restricted hosts typically need administrator/bootstrap access for initial installation. Review other sudoers/group/polkit grants before claiming hard restriction. Removing those grants/resetting existing configuration is a separate explicitly confirmed change.

## Operate hosts and approve destruction

```sh
homectl hosts --json
homectl inspect lab-printer --json
homectl exec lab-printer -- sudo -n apt update
homectl exec lab-printer -- sudo -n apt full-upgrade -y
homectl exec lab-printer -- systemctl is-active klipper moonraker
homectl exec lab-printer -- sudo -n systemctl restart moonraker
```

Separate argv are passed literally; SSH shell quoting prevents substitutions/redirections becoming local or remote shell syntax. For a shell script, use `sh -c` explicitly; opaque commands require reviewing effects and exact confirmation because the CLI cannot prove what they do. `homectl ssh <host> -- command...` is the guarded exec alias; it does not open an unguarded interactive shell.

Known destructive commands are classified. Unknown tools, interpreters and complex wrappers are conservatively treated as opaque and require confirmation. Non-destructive recognized sudo operations use the native approval model without an extra custom confirmation. Classification is not a complete semantic analyzer: binaries, package hooks and system accounts must be trusted. For observe, use supported inspection commands such as `df`, `uname`, `systemctl status/is-active`, or non-mutating journalctl; rejected inspection variants can be added after review, never worked around through raw execution.

Before deletion, the agent resolves exact targets and shows the user the host, command and consequence:

```sh
homectl exec lab-printer --dry-run --json \
  --impact 'Delete only /srv/lab/obsolete-test.gcode on lab-printer; that file cannot be recovered by homectl' \
  -- rm -- /srv/lab/obsolete-test.gcode
```

The plan contains an approval digest bound to host, inventory configuration, argv and impact. Without confirmation the actual command exits 4 **before execution**. Only after the user confirms that exact operation:

```sh
homectl exec lab-printer --json \
  --impact 'Delete only /srv/lab/obsolete-test.gcode on lab-printer; that file cannot be recovered by homectl' \
  --approval <digest-from-approved-plan> \
  -- rm -- /srv/lab/obsolete-test.gcode
```

A human native approval displaying the exact destructive command/target/impact counts once. No extra chat confirmation follows it. Automatic approval, “fix/update/clean the host” and full/root access do **not** count. Every later destructive operation needs its own confirmation; do not reuse a digest as standing authorization. A digest is a workflow attestation, **not proof of human identity or an unforgeable authorization token**. Skills enforce who may supply it; arbitrary same-user code can bypass the workflow. There is no blanket `--yes` flag. Destructive actions outside homectl, including temporary-file deletion and configuration resets, follow the same skill rule.

## Provision a Proxmox VM

Use a prepared Debian/Ubuntu cloud-init template on the selected node. It needs a cloud-init drive, boot disk (default `scsi0`), existing user matching `ciuser`, QEMU guest agent/cloud-init tools and public-key SSH authentication. Use a disk at or below the requested size; provisioning only requests growth and never partitions/formats or shrinks existing storage. The API token needs privileges for template cloning, VM allocation/config/disk changes and power operations; use Proxmox's API viewer to determine ACLs for your actual storage/pool/node. TLS verification is mandatory; trust your homelab CA in the agent runtime rather than disabling certificate checks.

For a full VM, a non-root template user must already have NOPASSWD bootstrap access; homectl adds its validated existing-user rule after boot. A root template user already has root authority, so homectl skips sudoers installation and runs requested package recipes directly as root. For observe/user, use an appropriately configured template and treat enforcement as advisory. For sudo-approved, prepare the desired restricted rules in the template or provide administrator bootstrap access for initial installation; adding a limited file to a template with NOPASSWD: ALL does not restrict that account. Tier-specific template preparation is required; automatic removal of inherited privileges is intentionally not performed.

Add a provider using [the example inventory](examples/inventory.example.yaml). The Proxmox API token secret lives in the password field of its referenced vault item. Adapt [examples/vm.example.json](examples/vm.example.json), including a real **public** key and an explicit unused VMID/static IP:

```sh
homectl provision --file /path/vm.json --dry-run --json
homectl provision --file /path/vm.json --json
```

This generates a plan, clones a template via the API, configures CPU/RAM/static network/SSH key, grows disk, boots, waits for bounded API tasks and SSH/cloud-init, installs requested sudoers, enrolls and verifies optional software. Docker uses Debian's `docker.io` package; Bun uses a pinned `bun@1.4.2` npm package after installing Node/npm. Post-provision recipes assume Debian/Ubuntu and full; arbitrary packages are not accepted. Codex/Claude are never installed.

A new VM's first SSH connection needs trusted `known_hosts` setup. If the first run waits/times out while you establish fingerprint trust through the console, rerun **the same request** to resume. Journals are stored under `~/.config/homectl/state`; the API VM description binds ownership to a plan fingerprint. Repeated completed API steps are skipped. Conflicting VMIDs, changed plans, lost journals/ownership markers and uncertain clone/task states fail for manual inspection. No automatic VM destruction or rollback occurs. Run one provisioning operation at a time; simultaneous applies are not currently supported.

Template creation/image import, DHCP discovery, Windows setup and automated privilege tightening are tracked in GitHub issues. Use the prepared template path rather than a fake generalized Terraform interface. The provider interface accepts pure plan generation and API injection so more backends can be added.

## Troubleshooting and verification

```sh
homectl doctor
homectl doctor lab-printer --json
bun run check
```

| Exit | Meaning |
|---|---|
| 0 | Success / dry-run |
| 2 | Invalid input, schema or missing inventory |
| 3 | Policy violation or conflicting existing state |
| 4 | Exact user confirmation required |
| 5 | Process, credential/provider or bootstrap failure |
| 6 | Executed command failed; result carries its actual exit code |

Doctor reports optional AAC/bw availability separately from required SSH/Bun and host connectivity. It does not dump provider secrets and never executes an allowlisted service restart as a check. For full non-root SSH users, it probes `sudo -n true`; for a root SSH account it checks connectivity directly because root does not need sudo. For limited sudo, inspect the rendered policy and have an administrator verify actual system grants. Tool availability and `bw status` do not prove AAC pairing, listener unlock or approval state.

On authentication failure, follow `doctor`'s classified remediation: verify the address/user and network; compare changed SSH fingerprints through a trusted console before editing known_hosts; check loaded key/socket or AAC listener unlock and request approval. On sudo bootstrap failure: use initial trusted interactive admin access. SSH enrollment of a Proxmox root account validates SSH connectivity only; VM creation uses a separate Proxmox API token/provider configuration. On Proxmox API failure: inspect tasks and the journal, then resume the identical request when the cause is fixed. Do not erase a journal or recreate storage to force progress. Changes to pre-existing inventory/VM/config state require inspection and explicit approval if destructive. Installation temporary artifacts are retained for inspection instead of automatically deleted.

Tests use fakes and local subprocesses, not your real homelab. They cover inventory/secrets, command policy, approval fingerprints, local/SSH argv, AAC isolation/redaction, setup/enrollment, dry-run, API provisioning/resume/collisions and actual CLI exit codes. CI runs typecheck, Biome lint and Bun tests. No secrets or real host details are required in CI.
