// Full-mode routes for guests (QEMU VMs and LXC containers). {type} is qemu or
// lxc; the same rows serve both. Order matters: the first match wins, so the
// specific guest-agent rows come before the generic ones.
import { type FullRoute, route } from "./full-route-types";

const G = "nodes/{node}/{type}/{vmid}";

export const FULL_GUEST_ROUTES: readonly FullRoute[] = [
  route("GET", "nodes/{node}/{type}", "R1", "List guests on {node}"),
  route(
    "POST",
    "nodes/{node}/{type}",
    "R3",
    "Create or restore a guest on {node}",
  ),
  route("GET", `${G}/status/current`, "R1", "Status of {guest}"),
  route("GET", `${G}/config`, "R1", "Configuration of {guest}"),
  route("GET", `${G}/pending`, "R1", "Pending changes of {guest}"),
  route("GET", `${G}/rrddata`, "R1", "Performance history of {guest}"),
  route("GET", `${G}/snapshot`, "R1", "Snapshots of {guest}"),
  route("GET", `${G}/snapshot/{id}/config`, "R1", "Snapshot of {guest}"),
  route("POST", `${G}/status/start`, "R2", "Start {guest}"),
  route("POST", `${G}/status/stop`, "R2", "Force stop {guest}"),
  route("POST", `${G}/status/reset`, "R2", "Hard reset {guest}"),
  route("POST", `${G}/status/reboot`, "R2", "Reboot {guest}"),
  route("POST", `${G}/status/shutdown`, "R2", "Shut down {guest}"),
  route("POST", `${G}/status/suspend`, "R2", "Suspend {guest}"),
  route("POST", `${G}/status/resume`, "R2", "Resume {guest}"),
  route("PUT", `${G}/config`, "R2", "Change the configuration of {guest}"),
  route("PUT", `${G}/resize`, "R2", "Resize a disk of {guest}"),
  route("POST", `${G}/clone`, "R2", "Clone {guest}"),
  route("POST", `${G}/move_disk`, "R3", "Move a disk of {guest}"),
  route("POST", `${G}/migrate`, "R3", "Migrate {guest}"),
  route(
    "POST",
    `${G}/template`,
    "R3",
    "Turn {guest} into a template (cannot be undone)",
  ),
  route("POST", `${G}/snapshot`, "R2", "Take a snapshot of {guest}"),
  route(
    "POST",
    `${G}/snapshot/{id}/rollback`,
    "R4",
    "Roll {guest} back to a snapshot (current state is lost)",
  ),
  route("DELETE", `${G}/snapshot/{id}`, "R4", "Delete a snapshot of {guest}"),
  route("DELETE", G, "R4", "Destroy {guest} and purge its disks"),
  route("GET", `${G}/firewall/**`, "R1", "Firewall rules of {guest}"),
  route(
    "POST",
    `${G}/firewall/**`,
    "R4",
    "Change firewall rules of {guest}",
    true,
  ),
  route(
    "PUT",
    `${G}/firewall/**`,
    "R4",
    "Change firewall rules of {guest}",
    true,
  ),
  route(
    "DELETE",
    `${G}/firewall/**`,
    "R4",
    "Change firewall rules of {guest}",
    true,
  ),
  route(
    "GET",
    `${G}/agent/file-read`,
    "R4",
    "Read a file inside {guest} through its agent",
    true,
  ),
  route("GET", `${G}/agent/**`, "R1", "Guest agent information for {guest}"),
  route(
    "POST",
    `${G}/agent/exec`,
    "R4",
    "Run a command inside {guest} through its agent",
    true,
  ),
  route(
    "POST",
    `${G}/agent/file-write`,
    "R4",
    "Write a file inside {guest} through its agent",
    true,
  ),
];
