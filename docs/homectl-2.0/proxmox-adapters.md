# Proxmox adapters (slice 5, basic QEMU and LXC lifecycle)

Status: design, then implementation on this branch. Nothing here has been run against a real Proxmox node. Tests use recorded, synthetic fixtures (node `pve-test`, VMIDs 9001–9010). Scope is homelab #5 "D6B": basic QEMU and LXC lifecycle.

## Starting point (what exists, and what does not)

- `src/provisioners/`: a QEMU cloud-init clone path that drives `pvesh` over the managed SSH key (`sudo -n pvesh` for non-root users). It is the provisioning path used by `homectl` setup, and it stays as it is.
- Not in place before this slice: typed guest lifecycle through the control plane, LXC create, and any `qm`/`pct` action reachable from MCP. `qm` and `pct` argv were refused by the control plane's screening (`CONTAINER_CONTROL`, and full-access hosts are refused outright).
- LXC create and LXC lifecycle are **new in this slice**. They are not claimed as existing behaviour and are not verified on a real node.

## Decisions

1. **Typed catalogue, exact argv.** Every operation is one entry in a fixed catalogue. Each entry builds one exact argv from validated fields. No free-form argv is accepted for `qm` or `pct`.
2. **Same plan path.** Each catalogue entry becomes an ordinary plan (`op: "plan"` semantics): same fingerprint, approval, lease, fence and audit. Only the planning front door is new.
3. **Separate MCP tool, `homectl_proxmox_plan`.** Chosen over typed actions on `homectl_plan` because (a) the agent never types argv for a guest, so the schema can carry the typed fields and nothing else; (b) the tool's own schema is smaller and cannot be confused with a free-form plan; (c) a separate request op (`proxmox-plan`) keeps the generic `plan` refusal for `qm`/`pct` intact. The tool still returns the plan summary in the same text style.
4. **Facts from the inventory.** Provider entries (`providers.<name>`, type `proxmox`) already name the host and the node. This slice adds optional facts: `vmid_range` (default 100–999999999), `storages` (ids allowed for clone and LXC root disks) and `templates` (LXC template names allowed for create). Validation refuses any value outside these facts. Node names are never taken from the request.
5. **Access tier: `full`, catalogue path only.** A Proxmox host must be `full` (the existing provider rule), because `qm`/`pct` run through `sudo -n`. The control plane refuses full-access hosts and refuses `qm`/`pct` control in general. This slice relaxes exactly those two checks for plans that come from the catalogue, marked by a `catalogue` flag on the plan. The flag is carried into execution, so the exec policy accepts the same argv there. Generic `plan`, `exec` and every other host keep the old refusals.
6. **Labels.** The impact text is the friendly label, for example `Start VM 9003 (sample-vm)`. The Approvals row already shows the impact above the exact argv, so the panel needs no change. A label that names a VM uses the name the planner supplies; the label is informational and the exact argv is what runs.

## Catalogue

Argv shown after the optional `sudo -n` prefix (added when the SSH user is not `root`). `VMID`, `TEMPLATE`, `NAME`, `STORAGE` and `BRIDGE` are validated against the provider facts and the patterns below before any argv is built.

| Action | Kind | Argv | Class |
|---|---|---|---|
| list | qemu / lxc | `qm list` / `pct list` | inspect |
| status | qemu / lxc | `qm status VMID` / `pct status VMID` | inspect |
| config | qemu / lxc | `qm config VMID` / `pct config VMID` | inspect |
| start | qemu / lxc | `qm start VMID` / `pct start VMID` | mutation |
| stop | qemu / lxc | `qm stop VMID` / `pct stop VMID` | mutation |
| reboot | qemu / lxc | `qm reboot VMID` / `pct reboot VMID` | mutation |
| shutdown | qemu / lxc | `qm shutdown VMID --timeout T` / `pct shutdown VMID --timeout T` (T 10–600, default 120) | mutation |
| clone | qemu | `qm clone TEMPLATE_VMID VMID --name NAME --full 1 [--storage STORAGE]` | mutation |
| create | lxc | `pct create VMID STORAGE:vztmpl/TEMPLATE --hostname NAME --unprivileged 1 --memory MB --cores N --rootfs STORAGE:GB --net0 name=eth0,bridge=BRIDGE,ip=(dhcp or CIDR,gw=GW)` | mutation |
| destroy | qemu / lxc | `qm destroy VMID --purge` / `pct destroy VMID --purge` | destructive |

Patterns: VMID is an integer in the provider's range. NAME is `^[a-z][a-z0-9-]{0,62}$`. TEMPLATE (LXC) is `^[A-Za-z0-9._+-]{1,128}\.tar\.(gz|xz|zst)$` and must be in `templates`. STORAGE must be in `storages`. BRIDGE is `^vmbr[0-9]{1,3}$`. Memory is 128–1048576 MB, cores 1–256, root disk 1–65536 GB. Static addresses are IPv4 with a CIDR of 1–32 and an IPv4 gateway. Clone never uses the template VMID as the target. `--unprivileged 1` is always set for LXC create: a privileged container is not in the catalogue.

Refused, always: any other `qm`/`pct` subcommand, any free-form argv for `qm`/`pct`, `--purge` on anything but destroy, node names from the request, and any argv that the existing screening already refuses (shells, interpreters, runtime sockets).

## Capability review

The minimum privilege for each action on a stock Proxmox node, as understood from the Proxmox tooling. **Not verified on a real node in this slice.**

| Action | Minimum on the node (as used here) | Least-privilege variant (not implemented) |
|---|---|---|
| list, status, config (qm, pct) | read of `/etc/pve`; root in practice (`sudo -n`) | `pvesh get /nodes/NODE/qemu` (or `/lxc`) with a PVEAuditor role on `/vms` |
| start, stop, reboot, shutdown | root (`sudo -n`), or a PVEVMAdmin-style role | `pvesh create .../status/START|STOP|...` with PVEVMAdmin on `/vms/VMID` |
| clone | root (`sudo -n`) | PVEVMAdmin on `/vms`, plus `Datastore.AllocateSpace` on STORAGE and `VM.Clone` on the template |
| LXC create | root (`sudo -n`) | PVEVMAdmin on `/vms`, plus `Datastore.AllocateSpace` on STORAGE; unprivileged is enforced by the argv |
| destroy | root (`sudo -n`) | PVEVMAdmin with `VM.Allocate`; purge is an explicit argv flag |

Tier mapping: inspect and mutation both need `sudo -n` on a `full` host in this model, so an `observe` or `user` host cannot use Proxmox actions at all. This is the honest cost of using `qm`/`pct`. The least-privilege variant (a pvesh API token with a role, stored through the credential path) is the next step and is out of scope here, because it needs a token-storage decision.

## Tests plan

- Unit (`tests/proxmox-catalogue.test.ts`): argv exactness for every action; refusals (out-of-range VMID, unknown storage, template not allowlisted, node from request, `--purge` misuse, bad bridge, bad CIDR, shutdown timeout bounds, free-form `qm`/`pct`); classification of each argv; `sudo -n` prefix rule.
- Engine and MCP (`tests/control-proxmox.test.ts`) with a fake runner that returns recorded synthetic outputs for `qm list` and `pct list`: inspect runs without approval; mutation needs approval; destroy needs approval and is destructive; a free-form `qm` plan through the generic path is refused; a host without the Proxmox provider is refused; the approval label appears on the operation; execution uses the same argv that was planned.
- Nothing touches a real host: the runner is faked and no SSH process is started.

## Not done

- No real Proxmox node was contacted. The recorded outputs are synthetic.
- The existing QEMU cloud-init provisioner is unchanged.
- No pvesh API-token variant, no VM console or snapshot actions, no LXC templates download.
