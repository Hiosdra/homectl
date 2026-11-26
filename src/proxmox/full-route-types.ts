// Shape of one row in the full-mode Proxmox route table (full-routes.ts).
import type { Risk } from "../core/contracts";

export type FullMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface FullRoute {
  method: FullMethod;
  // Path template under /api2/json, without the leading slash. Literal segments
  // match exactly. Placeholders: {node} the provider node, {type} qemu or lxc,
  // {vmid} a guest id, {id} a name segment, {volume} a storage volume id. A
  // final "**" matches zero or more further name segments.
  template: string;
  // R1 read, R2 routine change, R3 significant change, R4 destructive or
  // owner-only. A GET is R1 unless it is owner-only (R4).
  risk: Risk;
  // Owner-only: the plan can be made and shown, but no client can approve it.
  ownerOnly: boolean;
  // Plain-language summary. {guest} becomes "VM 9001" or "container 9001",
  // {node} the provider node.
  label: string;
}

export function route(
  method: FullMethod,
  template: string,
  risk: Risk,
  label: string,
  ownerOnly = false,
): FullRoute {
  return { method, template, risk, ownerOnly, label };
}
