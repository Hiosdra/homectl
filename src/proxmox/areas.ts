// Plain-language area for a full-mode Proxmox path, shown on approvals and in
// the owner panel's Details. Pure: the area is a name for people, never a
// permission. The risk comes from the route table, not from this label.
const NODE_AREAS: Record<string, string> = {
  qemu: "Virtual machines and containers",
  lxc: "Virtual machines and containers",
  storage: "Storage",
  vzdump: "Backups",
  execute: "Commands on the server",
  network: "Network",
  firewall: "Firewall",
  services: "The Proxmox server",
  apt: "The Proxmox server",
  time: "The Proxmox server",
  dns: "The Proxmox server",
  hosts: "The Proxmox server",
  disks: "The Proxmox server",
  syslog: "The Proxmox server",
  journal: "The Proxmox server",
  status: "The Proxmox server",
  version: "The Proxmox server",
  tasks: "The Proxmox server",
  rrddata: "The Proxmox server",
};

const TOP_AREAS: Record<string, string> = {
  storage: "Storage",
  pools: "Resource pools",
  access: "Users and permissions",
  version: "The Proxmox server",
};

const CLUSTER_AREAS: Record<string, string> = {
  backup: "Backups",
  replication: "Replication",
  ha: "High availability",
  firewall: "Firewall",
  sdn: "Software-defined networking",
};

// The area a path belongs to. Unknown shapes fall back to "Proxmox".
export function routeArea(path: string): string {
  const [first, second, third] = path.replace(/^\//, "").split("/");
  if (first === "nodes") return NODE_AREAS[third ?? ""] ?? "The Proxmox server";
  if (first === "cluster") {
    const area = CLUSTER_AREAS[second ?? ""];
    return area ?? "Cluster";
  }
  return TOP_AREAS[first ?? ""] ?? "Proxmox";
}
