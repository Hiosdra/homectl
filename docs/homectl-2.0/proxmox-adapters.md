# Proxmox adapters (slice 5, basic QEMU and LXC lifecycle)

Status: implemented on this branch (catalogue, planning, MCP tool, tests). **Nothing here has been run against a real Proxmox node**; the capability review below is unverified. Tests use a fake runner and synthetic fixtures (node `pve-test`, VMIDs 9001–9010). Scope is homelab #5 "D6B": basic QEMU and LXC lifecycle.

## Starting point (what exists, and what does not)

- `src/provisioners/`: a QEMU cloud-init clone path that drives `pvesh` over the managed SSH key (`sudo -n pvesh` for non-root users). It is the provisioning path used by `homectl` setup, and it stays as it is.
- Not in place before this slice: typed guest lifecycle through the control plane, LXC create, and any `qm`/`pct` action reachable from MCP. `qm` and `pct` argv were refused by the control plane's screening (`CONTAINER_CONTROL`, and full-access hosts are refused outright).
- LXC create and LXC lifecycle are **new in this slice**. They are not claimed as existing behaviour and are not verified on a real node.

## Decisions

1. **Typed catalogue, exact argv.** Every operation is one entry in a fixed catalogue. Each entry builds one exact argv from validated fields. No free-form argv is accepted for `qm` or `pct`.
2. **Same plan path.** Each catalogue entry becomes an ordinary plan (`op: "plan"` semantics): same fingerprint, approval, lease, fence and audit. Only the planning front door is new.
3. **Separate MCP tool, `homectl_proxmox_plan`.** Chosen over typed actions on `homectl_plan` because (a) the agent never types argv for a guest, so the schema can carry the typed fields and nothing else; (b) the tool's own schema is smaller and cannot be confused with a free-form plan; (c) a separate request op (`proxmox-plan`) keeps the generic `plan` refusal for `qm`/`pct` intact. The tool still returns the plan summary in the same text style.
4. **Facts from the inventory.** Provider entries (`providers.<name>`, type `proxmox`) already name the host and the node. This slice adds optional facts: `vmid_range` (inspection defaults to 100–999999999; every change needs it set), `protected_vmids` (VMIDs that destroy always refuses), `storages` (ids allowed for clone and LXC root disks) and `templates` (LXC template names allowed for create). Validation refuses any value outside these facts. Node names are never taken from the request.
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

Range rules: `start`, `stop`, `reboot`, `shutdown`, `clone`, `create` and `destroy` refuse to plan unless the inventory sets `vmid_range` for the host, with the message `Set vmid_range for <host> in the inventory before planning VM changes`. `list`, `status` and `config` use the default range. `destroy` also needs the guest name, which appears in the label and impact (for example `Destroy VM 9007 (sample-old) and purge its disks`), and refuses any VMID listed in `protected_vmids`.

Refused, always: any other `qm`/`pct` subcommand, any free-form argv for `qm`/`pct`, `--purge` on anything but destroy, node names from the request, and any argv that the existing screening already refuses (shells, interpreters, runtime sockets).

## Capability review

The minimum privilege for each action on a stock Proxmox node, as understood from the Proxmox tooling. **Not verified on a real node in this slice.**

| Action | Minimum on the node (as used here) | Least-privilege variant (not implemented) |
|---|---|---|
| list, status, config (qm, pct) | read of `/etc/pve`; root in practice (`sudo -n`) | a custom role with `VM.Audit` and `Sys.Audit`. The built-in PVEAuditor role is a candidate, but its exact privileges were not checked. |
| start, stop, reboot, shutdown | root (`sudo -n`) | a custom role with `VM.PowerMgmt` and `VM.Audit` on `/vms/VMID`. The built-in PVEVMUser role also covers power, but adds console and CD-ROM rights, so it is broader than needed. PVEVMAdmin is broader still. |
| clone | root (`sudo -n`) | `VM.Clone` on the template, `VM.Allocate` on the target, `Datastore.AllocateSpace` on STORAGE |
| LXC create | root (`sudo -n`) | `VM.Allocate` and `Datastore.AllocateSpace` on STORAGE, plus `SDN.Use` for the bridge. Whether a non-root API user can create LXC with only these is **unverified**. Unprivileged is enforced by the argv. |
| destroy | root (`sudo -n`) | `VM.Allocate` on `/vms/VMID`. Whether disk removal also needs datastore rights is **unverified**. Purge is an explicit argv flag. |

Privilege names are from the Proxmox VE administration guide, access-control section (checked 2026-11-10). The built-in role contents are from the same guide and were not checked on a node.

Tier mapping: inspect and mutation both need `sudo -n` on a `full` host in this model, so an `observe` or `user` host cannot use Proxmox actions at all. This is the honest cost of using `qm`/`pct`. The least-privilege variant (a pvesh API token with a role, stored through the credential path) is the next step. It needs a decision on where the token is stored and how it is used, and it is out of scope for this slice.

## Tests plan

- Unit (`tests/proxmox-catalogue.test.ts`): argv exactness for every action; refusals (out-of-range VMID, unknown storage, template not allowlisted, node from request, `--purge` misuse, bad bridge, bad CIDR, shutdown timeout bounds, free-form `qm`/`pct`); classification of each argv; `sudo -n` prefix rule.
- Engine and MCP (`tests/control-proxmox.test.ts`) with a fake runner that returns recorded synthetic outputs for `qm list` and `pct list`: inspect runs without approval; mutation needs approval; destroy needs approval and is destructive; a free-form `qm` plan through the generic path is refused; a host without the Proxmox provider is refused; the approval label appears on the operation; execution uses the same argv that was planned.
- Nothing touches a real host: the runner is faked and no SSH process is started.

## Not done

- No real Proxmox node was contacted. The recorded outputs are synthetic.
- The existing QEMU cloud-init provisioner is unchanged.
- No VM console or snapshot actions, no LXC templates download.
- The API-token transport (section 14) is implemented and tested with a fake HTTP layer. It has **not** been run against a real node.

## Implementation

- Catalogue and validation: `src/proxmox/catalogue.ts`. `buildProxmoxPlan` builds the exact argv and the friendly label; `catalogueClass` is the shape-only check the exec policy uses; `providerFacts` reads the provider entry.
- Inventory facts: optional `vmid_range`, `protected_vmids`, `storages` and `templates` on a `providers` entry (schema and parser checked). Without `vmid_range`, inspection uses 100–999999999 and every change is refused. Without `storages` or `templates`, no storage or template is allowed for clone or create.
- Planning: MCP tool `homectl_proxmox_plan` (op `proxmox-plan`, scope `plan:create`). The engine resolves the provider for the host, builds the argv, prefixes `sudo -n` unless the SSH user is `root`, and creates an ordinary plan through the shared `createPlan`. Fingerprint, approval, lease, fence and audit are unchanged.
- Policy: a generic plan (`op: plan`, `homectl exec`) refuses every `qm` and `pct` argv. A catalogue plan is accepted only in one of the exact forms, and its `catalogue` flag is kept on the plan so execution and the fingerprint re-check apply the same rule.
- Screening: the control plane refuses full-access hosts and `qm`/`pct` control in general. Catalogue plans are the one exception; shells, interpreters, runtime sockets and the other existing refusals still apply.
- Labels: the friendly label is the operation's impact text, which the Approvals row already shows above the exact argv, so the panel is unchanged.
- Found while testing: the re-check at execution rebuilt the plan without the catalogue flag and would have refused every catalogue operation as stale. It now rebuilds with the flag.
- LXC create and LXC lifecycle are new in this slice and are unverified on a node. The existing QEMU cloud-init provisioner is unchanged.

## 14. API-token transport (option B)

Opt-in per provider. Without an `api` block the SSH path runs as before.

```yaml
providers:
  pve-test:
    type: proxmox
    host: pve-host          # SSH host, still required for inventory checks
    node: pve-test
    api:
      url: https://pve.example:8006     # https origin only; no path
      ca_file: /home/operator/.config/homectl/pve-root-ca.pem   # absolute path
      token_entry: homectl-pve-token    # KDBX entry
```

- The KDBX entry holds the token. UserName is `user@realm!tokenid`, and Password is the secret.
- `session unlock` loads the token into the session agent, in memory only. Lock or expiry clears it. The agent refuses names outside a fixed pattern.
- A plan that needs the token and finds the session locked is refused. The operation stays approved, and no request is sent.
- Each catalogue action becomes one REST call. The call is derived from the approved argv, so the approver and the executed call match. Reads: `GET` on `status/current`, `config` or the guest list. Power actions: `POST .../status/{start,stop,reboot,shutdown}`. Clone: `POST /nodes/{node}/qemu/{template}/clone`. LXC create: `POST /nodes/{node}/lxc`. Destroy: `DELETE .../{vmid}?purge=1`.
- Mutations return a task id. The task is polled until it stops. Exit OK means success. An error exit, or a task still running after the budget (5 minutes), is recorded as failed or unknown. Nothing is retried.
- TLS is verified against `ca_file` only. There is no insecure mode. Redirects are refused. The token is never printed or stored in the operation record.
- Least privilege for the API token: create it on the node with a custom role that holds only the privileges in section 1. That step is still a live action, and it is not done yet.

Not verified: the endpoint shapes and the role privileges against a real Proxmox node. Those are the first checks to run once the owner approves a disposable VMID range.
