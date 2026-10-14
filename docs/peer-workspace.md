# Local workspace, pairing and peer sync

Run the current checkout with Bun 1.4.2 or newer. The browser UI is English, dark, and local; no cloud account or frontend framework is required.

## Start temporarily

```sh
homectl serve --interface 192.168.1.10
```

Replace that IP with **this computer's** LAN interface address. The panel binds `127.0.0.1:7447`; the peer protocol binds the selected interface on port 7448. With no `--interface`, both channels are loopback-only. Wildcard binding is refused. `--port`, `--peer-port` and `--no-discovery` are available. Ctrl+C stops this instance and locks its SSH session.

In a separate **private terminal**, run:

```sh
homectl panel
```

The launcher uses a private local access token in the URL fragment. The frontend removes the fragment immediately after connecting and uses an HttpOnly SameSite cookie. Do not copy launch URLs into agent chat. The launch information lives in `serve/panel.json` beside the selected inventory. The CLI peer commands use this file internally and never print its token.

Starting `serve` does not install a service, open pairing, create a vault, unlock credentials, alter a firewall, or connect to a managed machine. Run `homectl setup` interactively to review and configure scoped firewall rules. Windows and Linux firewalls require an inbound rule for peer TCP and mDNS UDP 5353 on the selected private LAN. No router forwarding is needed.

## Pair two devices

On **both computers**, run in a private interactive terminal:

```sh
homectl pair
```

The command starts a temporary workspace if none is running, chooses the only private LAN IPv4 interface (or asks you to select one), opens a five-minute pairing window and discovers other devices running the same command. With multiple devices, select the endpoint. One device displays a one-time code; enter it on the other. Compare the verification phrase visually and confirm with `y` **on both** devices. Enter or `n` cancels. Discovery never replaces this verification. Only sync is granted initially; no auth is transferred during pairing.

A temporary workspace remains running after success so the other device can finish confirming and both can open `homectl panel` from a separate terminal to sync. Ctrl+C closes pairing and stops only the workspace started by this command. Existing serve/service processes stay running. You can choose an interface explicitly with `homectl pair --interface <local-LAN-IP>`. An existing workspace must have LAN discovery enabled on a LAN interface; loopback-only serve cannot advertise to another computer.

For manual fallback, start `serve --interface <local-LAN-IP>` on both devices and use `pair open` on one, `pair join --address http://<other-LAN-IP>:7448` on the other, then `pair confirm` on each. The panel also supports pairing. Diagnostics and per-host operations remain separate local grants under **Permissions**.

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
homectl peers --json
homectl pair open                   # private interactive terminal
homectl pair join --address http://192.168.1.10:7448
homectl pair confirm                # compare and type the phrase privately
homectl pair poll
homectl pair status
homectl pair cancel
homectl sync preview PEER_ID --json
homectl sync apply PREVIEW_ID --file choices.json
homectl sync cancel PREVIEW_ID
homectl peer PEER_ID --target nas --dry-run -- uname -s
homectl peer PEER_ID --target nas -- uname -s
```

`choices.json` is an object keyed by conflict ID, with `local`, `remote` or `both` values; `{}` explicitly accepts a conflict-free reviewed preview. Codes are not accepted as command-line arguments. `--dry-run` never accesses credentials or sends peer requests. CLI and UI use the same local backend and policies.

## Service mode

Linux and systemd-enabled WSL:

```sh
homectl service install --interface 192.168.1.10
homectl service start
homectl service status
homectl service logs
homectl service stop
homectl service uninstall
```

The systemd user unit uses private permissions, `UMask=0077`, restart-on-failure and `NoNewPrivileges`. It starts with locked credentials and closed pairing. Running without login requires a separate, explicit administrator decision to enable user lingering. `uninstall` removes the service registration, not inventory, vaults or peer trust.

For native Windows installation and Log On account setup, see [Windows and WSL](windows.md).

## Interactive setup and automation

`homectl setup` in a terminal walks through missing dependencies, LAN selection and firewall consent, then runs doctor. Linux supports apt/dnf/pacman for dependencies and firewalld/UFW for firewall configuration. Existing rules are preserved; firewalld rules are added to both runtime and permanent configuration without reloading the whole firewall. UFW is never enabled or disabled. Unsupported firewalls are reported for manual configuration. The selected LAN is saved locally and reused by `pair` while that address is still assigned.

For agents, `homectl setup --json` is noninteractive. Use `--install-deps` and/or `--configure-firewall --interface <local-IP>` explicitly; privileged operations require existing administrator rights or noninteractive sudo. `--dry-run` never installs packages or changes firewall rules. Setup does not initialize/unlock a vault or pair devices. Successful rule installation does not prove multicast reaches another computer across the LAN.

With the local workspace running, `homectl session unlock` unlocks both the SSH session and the synchronization vault using one private password prompt. `homectl session lock` locks both. An already unlocked SSH session alone does not imply an unlocked sync vault. Without a running workspace, unlock remains SSH-only and reports how to unlock sync; no database password is retained for a future workspace process. On a new device, initialize its local vault privately first (or create it from Access), then use the same command. Vault passwords remain local and may differ between devices.
