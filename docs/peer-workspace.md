# Local workspace, pairing and peer sync

Run the current checkout with Bun 1.4.2 or newer. The browser UI is English, dark, and local; no cloud account or frontend framework is required.

## Start temporarily

```sh
home-ctl panel
```

This opens the panel and starts a temporary workspace when needed. Homectl reuses the LAN address saved by setup, chooses the only available private address, or asks when there are several. With no LAN address it stays on this computer only. The panel itself remains bound to `127.0.0.1:7447`; the peer channel uses the selected interface on port 7448. Keep the terminal open while using the panel. Ctrl+C stops only the temporary workspace started by this command. If a service or workspace is already running, `panel` opens it and exits.

For explicit interface/port control, start the workspace yourself:

```sh
home-ctl serve --interface 192.168.1.10
# In another private terminal:
home-ctl panel
```

The launcher uses a private local access token in the URL fragment. The frontend removes the fragment immediately after connecting and uses an HttpOnly SameSite cookie. Do not copy launch URLs into agent chat. The launch information lives in `serve/panel.json` beside the selected inventory. The CLI peer commands use this file internally and never print its token.

Starting `serve` does not install a service, open pairing, create a vault, unlock credentials, alter a firewall, or connect to a managed machine. Run `home-ctl setup` interactively to review and configure scoped firewall rules. Windows and Linux firewalls require an inbound rule for peer TCP and mDNS UDP 5353 on the selected private LAN. No router forwarding is needed.

## Pair two devices

Open the panel on both computers:

```sh
home-ctl panel
```

On one device, choose **Devices → Start pairing**. On the other, enter the host's LAN address ending in `:7448` and the one-time code shown by the first device. If the host uses Docker, use the Docker host's LAN address and its published peer port, not the container IP. Compare the phrase and confirm on both devices. Discovery may fill the address automatically, but direct entry works across Docker, VLAN and Wi-Fi discovery boundaries. Only sync is granted initially; credentials are transferred later through the reviewed sync flow.

The CLI alternative is `home-ctl pair` on both devices. It starts a temporary workspace if necessary, discovers peers, and guides code and phrase verification. Keep its terminal open until pairing is complete; press Ctrl+C to stop the temporary workspace.

Discovery uses mDNS/DNS-SD `_homectl._tcp.local`. Advertisement is temporary and contains a random instance identifier, protocol version and pairing capability, never the code, vault contents, host inventory or stable device identity. The selected interface is used. Discovery is unauthenticated: selecting an endpoint does not establish trust. Multicast may be blocked by Wi-Fi isolation, VLAN boundaries or WSL networking; manual IP pairing uses the same authentication.

Pairing uses SRP-6a PAKE through the pinned `secure-remote-password` library, with one online attempt per open window. A wrong proof closes the attempt; generate a new code locally. The verification phrase binds the session and both device identities. This implementation uses SRP rather than the earlier SPAKE2 proposal; it does not implement custom PAKE arithmetic.

Subsequent messages use authenticated ephemeral X25519, HKDF-SHA256 and AES-256-GCM. Direction, peer IDs, request ID, challenge and ephemeral public keys are bound into the channel context. Challenges are short-lived and single-use; restart discards them. There is no relay or Internet rendezvous.

## First transfer and subsequent sync

On the new device, go to **Access** and create an encrypted vault if none exists. The same view can generate a new SSH key and show only its public key. Choose its local password privately. This password can differ from the first computer's password; it is never transmitted to a peer.

Unlock both local vaults, then choose **Sync** for a paired device. Inspect the proposed changes. For each conflict:

- **Use from this device** retains the local version.
- **Use from the other device** retains the received version.
- **Keep both** creates a new entry and a unique machine name/SSH alias when relevant.

Selecting a version collapses the comparison into a retained entry. **Compare again** reopens both panes. Credential conflicts show only fingerprints, never key or password values. Conflicting trusted host keys cannot be kept as two trusted versions: verify and choose one.

Applying locally sends an offer to the other peer. That peer also reviews before writing. No device is a permanent primary. Revision vectors distinguish later edits from concurrent edits; deletion tombstones prevent an older peer from silently resurrecting removed entries. The UI detects changed local data after preview and requires a new review.

Sync covers SSH machines, access policy, Proxmox provider definitions, `homectl-*` credential entries and their attachments, and relevant trusted SSH host keys. Public key files are reconstructed from credentials. Database paths, agent endpoints, local-host definitions, session TTL and active sessions stay local. No personal KeePass database entries outside the homectl namespace are transferred.

Plaintext credential payloads exist transiently inside an unlocked backend and an authenticated encrypted peer message. They are stored at rest only in KDBX. `peers.json` stores trust keys, grants and revision metadata under private filesystem permissions; credential record values on disk contain fingerprints only. Lock clears unlocked vault references and pending secret-bearing previews. KDBX saves detect external edits (including CLI/KeePassXC changes), refuse stale writes and retain encrypted backups. Sync also saves inventory backups. Multi-file updates are sequential rather than a crash-atomic transaction; after an interrupted apply, review the retained backups and refresh before retrying.

Trusted host keys are normalized into a managed `known_hosts` beside inventory. Relevant plain and hashed entries from the existing user store can be captured. OpenSSH uses the managed store for hosts with a managed key, preserving strict host checking. Importing does not weaken `StrictHostKeyChecking` or install keys on servers. Review imported access tiers and fingerprints. Existing connections can continue after local session lock.

Sync is explicitly initiated and reviewed in this version. A service remains available in the background, but unattended periodic synchronization is not enabled.

## Operate through a peer

Under a peer's local **Permissions**, grant diagnostics and select the hosts it may operate. Grant operation on the homectl computer itself separately. On the requesting computer, inspect the peer and select a host, or choose the execution device in **Command**.

The execution peer applies its current host policy and grants. Inspection can execute immediately with an unlocked local session. A mutation creates an in-memory request visible under **Machines → Operations awaiting your approval** on the execution peer. Approve the exact command and effect locally, or reject it. Changed host policy or revoked grants invalidate the approval. Lock or restart does not silently authorize it; a restart loses pending requests. The requester can check the result.

Removing trust stops future authenticated requests from that peer. It cannot revoke SSH keys already copied to it. Revoke/rotate those keys on the managed hosts, or enroll separate keys per device when independent revocation is needed.

## CLI equivalents

```sh
home-ctl peers --json
home-ctl pair                         # guided pairing on both devices
home-ctl pair join --address http://192.168.1.10:7448  # direct join; no serve prerequisite
home-ctl pair confirm                 # advanced: confirm a pending phrase
home-ctl pair poll                    # advanced: wait for the other confirmation
home-ctl pair status                  # advanced: inspect local pairing state
home-ctl pair cancel                  # advanced: cancel a pending invitation
home-ctl sync preview PEER_ID --json
home-ctl sync apply PREVIEW_ID --file choices.json
home-ctl sync cancel PREVIEW_ID
home-ctl peer PEER_ID --target nas --dry-run -- uname -s
home-ctl peer PEER_ID --target nas -- uname -s
```

`choices.json` is an object keyed by conflict ID, with `local`, `remote` or `both` values; `{}` explicitly accepts a conflict-free reviewed preview. Codes are not accepted as command-line arguments. `--dry-run` never accesses credentials or sends peer requests. CLI and UI use the same local backend and policies.

## Service mode

Linux and systemd-enabled WSL:

```sh
home-ctl service install --interface 192.168.1.10
home-ctl service start
home-ctl service status
home-ctl service logs
home-ctl service stop
home-ctl service uninstall
```

The systemd user unit uses private permissions, `UMask=0077`, restart-on-failure and `NoNewPrivileges`. It starts with locked credentials and closed pairing. Running without login requires a separate, explicit administrator decision to enable user lingering. `uninstall` removes the service registration, not inventory, vaults or peer trust.

For native Windows installation and Log On account setup, see [Windows and WSL](windows.md).

## Interactive setup and automation

`home-ctl setup` in a terminal walks through missing dependencies, LAN selection and firewall consent, then runs doctor. Linux supports apt/dnf/pacman for dependencies and firewalld/UFW for firewall configuration. Existing rules are preserved; firewalld rules are added to both runtime and permanent configuration without reloading the whole firewall. UFW is never enabled or disabled. Unsupported firewalls are reported for manual configuration. The selected LAN is saved locally and reused by `pair` while that address is still assigned.

For agents, `home-ctl setup --json` is noninteractive. Use `--install-deps` and/or `--configure-firewall --interface <local-IP>` explicitly; privileged operations require existing administrator rights or noninteractive sudo. `--dry-run` never installs packages or changes firewall rules. Setup does not initialize/unlock a vault or pair devices. Successful rule installation does not prove multicast reaches another computer across the LAN.

With the local workspace running, `home-ctl session unlock` unlocks both the SSH session and the synchronization vault using one private password prompt. `home-ctl session lock` locks both. An already unlocked SSH session alone does not imply an unlocked sync vault. Without a running workspace, unlock remains SSH-only and reports how to unlock sync; no database password is retained for a future workspace process. On a new device, initialize its local vault privately first (or create it from Access), then use the same command. Vault passwords remain local and may differ between devices.
