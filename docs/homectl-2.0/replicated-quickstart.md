# Replicated control mode: quickstart

Status: implemented on `feat/issue-5-control-plane` (ADR-0002 stages a to e). This guide describes behaviour covered by `tests/control-e2e.test.ts`, `tests/control-handoff.test.ts`, `tests/control-convergence.test.ts` and `tests/control-admin.test.ts`. It has not been run against two real hosts yet; the first live run is still to do.

Replicated mode lets paired devices share one control plane. Each device keeps its own MCP clients and tokens. Operations are planned on one device, approved from another, and run only on the device that owns them. Approvals, results and ownership changes travel over the authenticated peer channel by continuous sync.

## 1. Prerequisites

- Each device has homectl installed, its own inventory, and its own control state directory.
- The devices are paired (`homectl pair` on both, or the panel's pairing window). Pairing exchanges a per-device signing key. A device paired before signing keys existed has no key: pair it again. Until then it is **excluded from the lease** (section 5).
- Each device runs `homectl serve --interface <LAN-IP>`. Without `--interface` the peer channel listens on loopback only and the other device cannot reach it.

Use placeholders for addresses in your own notes. Never paste tokens, pairing codes or key material into chat or logs.

## 2. Start the devices

On each device, in a private terminal:

```sh
homectl serve --interface <LAN-IP>
```

- `--no-discovery` turns off multicast discovery only. Control sync with devices that are already paired keeps running. Use it on networks where multicast is blocked; pair by IP address instead.
- `--no-control-sync` turns control sync off on this device. Peers get "not running" from it, no round starts, and the panel's Control sync card says "disabled by --no-control-sync". Operations on this device that have signing peers then wait for a sync, because the lease cannot be renewed. Use it only when you do not want this device in the control plane.

Control sync runs inside `serve` every 15 seconds. There is no manual round button yet; the wait is at most one interval.

## 3. Add MCP clients on each device

Clients are device-local. Create each one on the device where its agent runs:

```sh
homectl control client add codex-pc --name "Codex PC" \
  --scopes status:read,inspect:read,plan:create --hosts agent-host \
  --token-file <private-path>
```

Give an approver `approve:decide` on the device where that approver's client lives. Its approvals are signed by that device and forwarded to the owner. Revocation on one device reaches the other on the next sync.

## 4. Plan, approve, run

1. An agent on device A calls `homectl_plan`. A is the owner of the new operation.
2. An approver on device B calls `homectl_approve`. B replies "Approval forwarded to owner A; it applies after the next sync". B shows the approval as "forwarded, awaiting confirmation" until A's state reflects it.
3. After the next sync, A applies the approval. B shows "approved by <client> (via <device>)".
4. The operator runs it on A: `homectl control execute <id>`, or Execute in A's Approvals view. On B the row reads "Runs on A" and has no Execute button.

Inspection plans need no approval. Changes always do.

## 5. Ownership, lease, handoff and takeover

Rules, in the order they apply:

- **Owner.** The planning device owns an operation. Only the owner runs it, and only the owner enforces single use.
- **Lease.** The owner runs an operation only while it has completed a sync, within the last 120 seconds, with every paired device that has a signing key. A device paired without a signing key is **excluded from the lease**: it cannot sign or verify records, so it never counts as synced and never blocks execution. The Sync view and `homectl control sync` show it as "excluded from lease: re-pair required". Expired lease: execution is refused with "Owner lease expired; waiting for sync with <device>". With no signing peers there is no lease.
- **Offered handoff (owner-initiated, two signatures).** The owner offers an operation to a named device: `homectl control handoff <id> --to <device>`, or "Hand off…" in the panel. From the moment the offer exists, the owner refuses to run that operation ("Handoff offered to <device>"). The receiver accepts with `homectl control handoff <id>` (no `--to`) on its own device, or "Accept handoff" in its panel. The accept starts the new epoch: the operation goes back to needs-approval on the receiver, as after a takeover. The receiver must have the host in its inventory.
- **Cancel.** While an offer is open the owner may withdraw it: `homectl control handoff <id> --cancel`, or "Cancel offer". A cancel wins only over an offer nobody has accepted. After it, the owner may run the operation again. A late accept for a cancelled offer is rejected.
- **Takeover (unreachable owner).** If the owner is unreachable, another device may take over with the same command on its own device. The takeover window opens 180 seconds after the owner's last contact (120 s lease plus 60 s skew). Before that, takeover is refused with the time it becomes possible.
- **Needs the host.** Whoever takes over or accepts must have the same host in its own inventory. Otherwise the change is refused and the message says to add the host.
- **After any change of owner.** The operation needs a fresh approval on the new owner. The old owner is refused if it returns: its lease is stale until it syncs, and after that it sees the new owner.
- **Conflict.** Two different takeovers at the same epoch leave the operation with no owner. Nobody can run it until it is resolved (next rule).
- **Resolution.** A device involved in the conflict proposes a winner: `homectl control resolve <id> --owner <device>`, or "Resolve…" in the Sync view. The proposal applies only when the named winner agrees by running the same command on its own device ("Accept resolution" in its panel). The winner must be online for that. If the winner proposes itself, it agrees at once. A second, different resolution at the same epoch is again a conflict, and stays visible.

Race to know about: an accept that the receiver signed before it saw the owner's cancel can still take effect on the receiver, while the owner rejects it. Both devices then hold the operation until someone looks at it. Each side still needs a fresh approval to run it, and the audit journal records both the offer and the cancel. Treat a cancel that races an accept as an incident to check with `homectl control show` on both devices.

## 6. What the CLI does without `serve`

`homectl control ops`, `show` and `sync` read the last saved state and say so. `homectl control sync` prints "serve not running — showing last saved state; backoff unknown". `homectl control handoff`, `resolve` and their `--cancel` form need `serve` and fail with "Start homectl serve first".

`homectl control execute` without `serve` still applies the lease fence against the saved state. If a signing peer has not been synced recently, the command is refused, as it would be inside `serve`.

## 7. Checking health

- `homectl control sync` (or Sync > Control sync in the panel): per device, the last successful sync, whether the lease holds, the backoff and retry time, refusals and exclusions, control conflicts and pending resolutions.
- `homectl control ops` and `show`: the owner (Runs on), any open offer, any forwarded approval, and any takeover availability.
- Devices in the panel: each peer's signing fingerprint. Compare it with the other device's own fingerprint through a trusted channel.

## 8. Troubleshooting: "why can't I execute?"

| You see | Why | What to do |
| --- | --- | --- |
| Row says "Runs on <device>" | Another device owns the operation. | Run it on that device. |
| "Handoff offered to <device>; this device will not run it" | This device offered the operation away. | Wait for the receiver to accept, or cancel the offer (`handoff --cancel`). |
| "Owner lease expired; waiting for sync with <device>" | No sync with that signing peer in 120 s. A powered-off laptop paired with signing keys blocks its peers until it syncs again. | Start `serve` on that device, or stop pairing it if it is not meant to be in the control plane. Check its last sync in `control sync`. |
| "excluded from lease: re-pair required" (Sync view) | The peer has no signing key, so it does not count toward the lease. | Pair the two devices again. |
| "Operation now belongs to <device>; it will not run here" | Ownership moved by a handoff or takeover. | Run it on the new owner, after approval there. |
| "Operation owner is not established; conflicting takeovers..." | Two takeovers at the same time. | Choose the owner with "Resolve…" in the Sync view, or `control resolve`. |
| "Resolution proposed ... applies once that device accepts" | The winner has not agreed yet. | Run `control resolve <id> --owner <winner>` on the winner's device. |
| "Re-pair this device to enable control sync" | The peer was paired before signing keys existed. | Pair the two devices again. |
| "Takeover possible after <time>" | The owner was seen recently. | Wait until the time shown, or let the owner come back. |
| "No recent contact with <device>; takeover is not possible" | No sync has ever been recorded with the owner. | Make sure both devices have synced at least once. |
| "Host <name> is not in this device's inventory" | A takeover or accept needs the host here. | Add the host to this device's inventory first. |
| "No paired device named <name>" | The handoff names a device that is not paired here. | Check the name in the Devices view, or use its id. |
| Approval shows "forwarded, awaiting confirmation" | The owner has not synced yet. | Wait for the next sync; check `control sync`. |
| "Control sync is disabled by --no-control-sync" | `serve` was started with the flag. | Start `serve` without it on this device. |
| "Start homectl serve first" (handoff, resolve) | Those commands need the running workspace. | Start `serve` on the device you are using. |

## 9. Security notes

- The local admin routes (`/api/control/sync`, `/api/control/handoff`, `/api/control/resolve`) use the panel's launch token and session cookie, compared in constant time. They are never on the peer channel or MCP. The launch token file is owner-only and is removed when `serve` stops.
- Every offer, cancel, accept, resolution proposal and resolution accept is written to the local audit journal as an identifier and a fixed reason (`handoff.offered`, `handoff.cancelled`, `handoff.accepted`, `handoff.resolution-proposed`, `handoff.resolution-accepted`).
- Signing keys are per device. Private keys never leave the device. POSIX refuses a key file readable by other users; on Windows the ACL is set when the key is created and not checked on each load.
- Remote approvals count only while the approving client is registered and not revoked on the owner.
