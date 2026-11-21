// The owner panel's calls for machines. Every write sends the owner password in
// the same request and the panel drops it afterwards. Only public facts come
// back: names, addresses, access levels, fingerprints and plain probe reasons.
import { ownerCall, ownerRead } from "./api";

export type AccessTier = "observe" | "user" | "sudo-approved" | "full";

export interface ProbeInfo {
  checkedAt: number;
  ok: boolean;
  os?: string;
  okAt?: number;
  reason?: string;
}

export interface AssistantRef {
  id: string;
  name: string;
}

export interface MachineRow {
  name: string;
  description: string;
  address: string;
  port: number;
  user: string;
  access: AccessTier;
  sudoAllow: string[];
  enforcement: string;
  caution: string[];
  // The SHA256 fingerprint of the pinned key, or null before a check.
  pinned: string | null;
  probe: ProbeInfo | null;
  assistants: AssistantRef[];
}

export interface KeyStatus {
  name: string;
  present: boolean;
  publicKey?: string;
  fingerprint?: string;
  reason?: string;
}

export interface ScanKey {
  type: string;
  fingerprint: string;
  pinned: boolean;
  revoked: boolean;
}

export interface ScanResult {
  address: string;
  trusted: false;
  notice: string;
  keys: ScanKey[];
}

export interface EnrollInput {
  password: string;
  name: string;
  address: string;
  port?: number;
  user: string;
  access: AccessTier;
  fingerprint: string;
  sudo_allow?: string[][];
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  os?: string;
  reason?: string;
  checkedAt: number;
}

export function listMachines(): Promise<{ machines: MachineRow[] }> {
  return ownerRead<{ machines: MachineRow[] }>("/v1/owner/hosts");
}

export function keyStatus(name: string): Promise<KeyStatus> {
  return ownerCall<KeyStatus>("/v1/owner/hosts/key-status", { name });
}

export function scanMachine(
  address: string,
  port: number | undefined,
  password: string,
): Promise<ScanResult> {
  return ownerCall<ScanResult>("/v1/owner/hosts/scan", {
    address,
    ...(port === undefined ? {} : { port }),
    password,
  });
}

export function enrollMachine(
  input: EnrollInput,
): Promise<{ name: string; os: string; pinned: string; access: AccessTier }> {
  return ownerCall("/v1/owner/hosts/enroll", { ...input });
}

export function checkMachine(
  name: string,
  password: string,
): Promise<ProbeResult> {
  return ownerCall<ProbeResult>("/v1/owner/hosts/probe", { name, password });
}

export function changeAccess(
  name: string,
  access: AccessTier,
  password: string,
  sudoAllow?: string[][],
): Promise<{ name: string; access: AccessTier }> {
  return ownerCall("/v1/owner/hosts/access", {
    name,
    access,
    password,
    ...(sudoAllow ? { sudo_allow: sudoAllow } : {}),
  });
}

export function removeMachine(
  name: string,
  password: string,
): Promise<{
  name: string;
  removed: true;
  assistantsUpdated: number;
  pinRemoved: boolean;
}> {
  return ownerCall("/v1/owner/hosts/remove", { name, password });
}
