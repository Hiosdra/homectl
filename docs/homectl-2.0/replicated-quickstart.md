# Replicated control mode: quickstart

Status: implemented on `feat/issue-5-control-plane` (ADR-0002 stages a to d). This guide describes behaviour covered by `tests/control-e2e.test.ts`, `tests/control-convergence.test.ts` and `tests/control-admin.test.ts`. It has not been run against two real hosts yet; the first live run is still to do.

Replicated mode lets two paired devices share one control plane. Each device keeps its own MCP clients and tokens. Operations are planned on one device, approved from another, and run only on the device that owns them. Approvals and results travel over the authenticated peer channel by continuous sync.

## 1. Prerequisites

- Each device has homectl installed, its own inventory, and its own control state directory.
- The devices are paired (`homectl pair` on both, or the panel's pairing window). Pairing exchanges a per-device signing key. A device paired before this feature has no signing key: pair it again before control sync will include it.
- Each device runs `homectl serve --interface <LAN-IP>`. Without `--interface` the peer channel listens on loopback only and the other device cannot reach it.

Use placeholders for addresses in your own notes. Never paste tokens, pairing codes or key material into chat or logs.

## 2. Start the devices

On each device, in a private terminal:

```sh
homectl serve --interface <LAN-IP>
```

`--no-discovery` turns off multicast discovery only. Control sync with devices that are already paired keeps running. Use it on networks where multicast is blocked; pair by IP address instead.

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

## 5. Ownership, lease and takeover

Rules, in the order they apply:

- **Owner.** The planning device owns an operation. Only the owner runs it, and only the owner enforces single use.
- **Lease.** The owner runs an operation only while it has completed a sync with every paired device in the last 120 seconds. If not, execution is refused with "Owner lease expired; waiting for sync with <device>". Start `serve` on the peers, or check the peer's status (section 7). With no paired devices there is no lease.
- **Takeover.** If the owner is unreachable, another device may take over. The takeover window opens 180 seconds after the owner's last contact (120 s lease plus 60 s skew). Before that, takeover is refused with the time it becomes possible.
- **Takeover needs the host.** The device taking over must have the same host in its own inventory. Otherwise the takeover is refused and the message says to add the host.
- **After takeover.** The operation needs a fresh approval on the new owner. The old owner is refused if it returns: its lease is stale until it syncs, and after that it sees the new owner.
- **Handoff is signed by the receiver.** `homectl control handoff <id> --to <device>` must run on that device. It needs a running `serve` there.

Ownership conflicts (two different takeovers at once) leave the operation with no owner. Nobody can run it until an operator resolves the conflict. Resolution is not implemented yet; the Sync view and `homectl control sync` show the conflict.

## 6. What the CLI does without `serve`

`homectl control ops`, `show` and `sync` read the last saved state and say so. `homectl control sync` prints "serve not running — showing last saved state; backoff unknown". `homectl control handoff` needs `serve` and fails with "Start homectl serve first".

`homectl control execute` without `serve` still applies the lease fence against the saved state. If a paired device has not been synced recently, the command is refused, as it would be inside `serve`.

## 7. Checking health

- `homectl control sync` (or Sync > Control sync in the panel): per device, the last successful sync, whether the lease holds, the backoff and retry time, refusals, and control conflicts.
- `homectl control ops` and `show`: the owner (Runs on), any forwarded approval, and any takeover availability.
- Devices in the panel: each peer's signing fingerprint. Compare it with the other device's own fingerprint through a trusted channel.

## 8. Troubleshooting: "why can't I execute?"

| You see | Why | What to do |
| --- | --- | --- |
| Row says "Runs on <device>" | Another device owns the operation. | Run it on that device. |
| "Owner lease expired; waiting for sync with <device>" | No sync with that device in 120 s. | Start `serve` on both devices. Check the peer's last sync in `control sync`. |
| "Operation now belongs to <device>; it will not run here" | Ownership moved by a takeover. | Run it on the new owner, after approval there. |
| "Operation owner is not established; conflicting takeovers..." | Two takeovers at the same time. | Not resolvable yet. Inspect with `control show`. |
| "Re-pair this device to enable control sync" | The peer was paired before signing keys existed. | Pair the two devices again. |
| "Takeover possible after <time>" | The owner was seen recently. | Wait until the time shown, or let the owner come back. |
| "No recent contact with <device>; takeover is not possible" | No sync has ever been recorded with the owner. | Make sure both devices have synced at least once. |
| "Host <name> is not in this device's inventory" | A takeover needs the host here. | Add the host to this device's inventory first. |
| Approval shows "forwarded, awaiting confirmation" | The owner has not synced yet. | Wait for the next sync; check `control sync`. |
| "Control sync is not running on this device" | `serve` is not running here. | Start `homectl serve`. |
| "Start homectl serve first" (handoff) | Handoff needs the running workspace. | Start `serve` on the receiving device. |

## 9. Security notes

- The local admin route (`/api/control/sync`, `/api/control/handoff`) uses the panel's launch token and session cookie. It is never on the peer channel or MCP. The launch token file is owner-only and is removed when `serve` stops.
- Signing keys are per device. Private keys never leave the device. POSIX checks that the key file is not readable by other users; on Windows the ACL is set when the key is created.
- Remote approvals count only while the approving client is registered and not revoked on the owner.
