export function inventoryText(caFile: string) {
  return `version: 1
session:
  ttl: 1h
  database: /tmp/homectl-synthetic/vault.kdbx
machines:
  pve-host:
    description: Synthetic Proxmox host
    transport: ssh
    access: full
    ssh_alias: pve-host
    address: 192.0.2.10
    user: ops
    auth:
      type: keepassxc
      entry: homectl-pve-host
      socket: /tmp/homectl-synthetic/agent.sock
      public_key: /tmp/homectl-synthetic/pve-host.pub
providers:
  pve-test:
    type: proxmox
    host: pve-host
    node: pve-test
    operations: full
    vmid_range: [9001, 9010]
    protected_vmids: [9009]
    storages: [local, local-test]
    templates: [debian-13-standard.tar.zst]
    api:
      url: https://pve.example:8006
      ca_file: ${caFile}
      token_entry: homectl-pve-token
`;
}
