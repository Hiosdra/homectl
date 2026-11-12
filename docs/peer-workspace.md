# Sync and pairing

[← Back to the README](../README.md)

Pair your computers, then sync the machines, access rules and credentials you choose. Nothing is applied until you review it. Every computer is equal; none is a permanent primary.

The browser panel is in English and runs locally. No cloud account is needed. Requires Bun 1.4.4 or newer for the source checkout.

## Open the panel

```sh
home-ctl panel
```

The panel listens on `127.0.0.1:7447` on this computer only. It starts a temporary workspace when needed, using the LAN address that setup saved. If there is no LAN address, the workspace stays on this computer. Peer connections use port `7448` on the chosen interface. Press `Ctrl+C` to stop the temporary workspace. If a service is already running, `panel` opens it and exits.

To control the interface yourself:

```sh
home-ctl serve --interface 192.168.1.10
# in another private terminal:
home-ctl panel
```

Starting `serve` does not install a service, open pairing, create a vault, unlock credentials, change a firewall or connect to managed machines. The launch link carries a private token in its fragment. Do not paste launch links into agent chat.

## Pair two devices

1. Open the panel on both computers with `home-ctl panel`.
2. On one device, choose **Devices → Start pairing**.
3. On the other, enter the first device's LAN address ending in `:7448`, and the one-time code it shows.
4. Compare the verification phrase on both devices and confirm it.

At first, a pairing grants sync only. Credentials move later, through the reviewed sync flow.

Finding a device on the network does not trust it. Discovery can fill in the address, but the one-time code and the phrase are what authenticate the pairing. Each open pairing window allows one attempt. A wrong code closes it, and you generate a new one. Discovery uses mDNS (`_homectl._tcp.local`). If multicast is blocked by Wi-Fi isolation, VLAN boundaries or WSL networking, enter the address by hand. Manual entry uses the same checks. With Docker, use the Docker host's LAN address and its published peer port.

On the command line, `home-ctl pair` on both devices guides you through the same steps. Keep its terminal open until pairing finishes.

## Sync changes

On a new device, create a vault in **Access** first, with a password of your choice. Vault passwords stay on their own computer and can differ between devices.

Then unlock both vaults, open **Sync** for a paired device, and review the proposed changes. For each conflict, pick one:

- **Use from this device** keeps the local version.
- **Use from the other device** keeps the received version.
- **Keep both** creates a new entry, with a unique machine name and SSH alias where needed.

Credential conflicts show fingerprints only, never key or password values. Conflicting trusted host keys cannot both be kept. Verify the fingerprint and choose one.

When you apply, the other device gets an offer and reviews it before writing anything. Deletions are recorded, so an older device cannot bring a removed entry back. The app refuses to apply a review made from data that changed afterwards. You will need a new review.

**What syncs:** SSH machines, access policy, Proxmox provider definitions, `homectl-*` credential entries with their attachments, and trusted SSH host keys.

**What stays local:** database paths, agent endpoints, this computer's host definitions, the session TTL and active sessions. Entries outside the `homectl` namespace in your KeePass database are never transferred.

Sync runs only when you start it. A service keeps the workspace available in the background, but unattended periodic sync is not enabled.

If an apply is interrupted, review the backups it kept and refresh before you retry. Several files are updated one after another, not in one atomic step. The database refuses stale writes, including changes made in KeePassXC, and keeps encrypted backups.

## Operate through a peer

On the computer that will be operated, grant diagnostics under **Permissions** and select the machines the peer may use. Grant operation on that computer separately. On the requesting computer, pick the execution device under **Command**.

The executing peer applies its own machine policy. Inspection runs right away when that computer is unlocked. Changes wait under **Machines → Operations awaiting your approval** on the executing computer. Approve the exact command and its effect there, or reject it. Changing the policy or revoking a grant invalidates an approval. A restart drops pending requests.

Removing a device's trust stops its future requests. It does not revoke SSH keys already installed on managed machines. Revoke or rotate those keys on the machines, or give each device its own key if you need to revoke them separately.

## Run as a service

On Linux, and on WSL with systemd enabled:

```sh
home-ctl service install --interface 192.168.1.10
home-ctl service start
home-ctl service status
home-ctl service logs
home-ctl service stop
home-ctl service uninstall
```

The systemd user unit uses private permissions and restarts on failure. It starts with credentials locked and pairing closed. Running without a login needs a separate decision to enable user lingering. `uninstall` removes the service registration only. Your inventory, vaults and device trust stay.

On native Windows, see [Windows and WSL](windows.md).

## Unlock both vaults at once

With the workspace running, `home-ctl session unlock` unlocks SSH and the sync vault with one password prompt. `home-ctl session lock` locks both. Without a running workspace, unlock covers SSH only and tells you how to unlock sync.

## Command reference

```sh
home-ctl peers --json
home-ctl pair                                             # guided pairing on both devices
home-ctl pair join --address http://192.168.1.10:7448     # join directly, no serve needed
home-ctl sync preview PEER_ID --json
home-ctl sync apply PREVIEW_ID --file choices.json
home-ctl sync cancel PREVIEW_ID
home-ctl peer PEER_ID --target nas --dry-run -- uname -s
home-ctl peer PEER_ID --target nas -- uname -s
```

Advanced pairing steps (`pair confirm`, `pair poll`, `pair status`, `pair cancel`) are in `home-ctl pair --help`.

`choices.json` maps each conflict ID to `local`, `remote` or `both`. An empty object `{}` accepts a preview with no conflicts. Pairing codes are never accepted as command-line arguments. `--dry-run` never reads credentials or sends peer requests. The CLI and the panel share one backend and the same policies.
