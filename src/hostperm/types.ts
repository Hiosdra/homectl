// Types for agentless host permission management (homectl 0.3.0, #21 C1-C3).
// homectl installs nothing on managed hosts: every operation is a native
// OS/SSH command issued through a RemoteExec on an admin-capable account.
import type { ProcessResult } from "../types";

// Runs one argv on the target. Commands are argv arrays, never shell strings;
// file contents travel only through `stdin`.
export type RemoteExec = (
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<ProcessResult>;

export type OsFamily = "linux" | "darwin" | "freebsd" | "unknown";

export interface PlatformSupport {
  dropIns: boolean;
  dedicatedAccount: boolean;
  authorizedKeys: boolean;
}

export interface Platform {
  os: OsFamily;
  id?: string;
  versionId?: string;
  visudo: boolean;
  sudoersD: boolean;
  // /etc/sudoers contains an active includedir for /etc/sudoers.d.
  sudoersInclude: boolean;
  canSudo: boolean;
  isRoot: boolean;
  useradd: boolean;
  // /etc/sudoers.d exists but is not writable under sudo (read-only system).
  readOnlyEtc: boolean;
  appliance: boolean;
  supports: PlatformSupport;
  // Fixed, user-readable explanations of every limitation. Never remote text.
  reasons: string[];
}

export type AccountModel =
  "existing-admin" | "existing-restricted" | "dedicated";

export interface PlannedStep {
  id: string;
  argv: string[];
  purpose: string;
}

export interface AccountPlan {
  supported: boolean;
  steps: PlannedStep[];
  reasons: string[];
}

// Requested sudo authority. "allow" entries are exact literal argv prefixes.
export type Grant = { kind: "full" } | { kind: "allow"; argv: string[][] };

// One executed step. `argv` holds paths and literals only; content is never
// included, and `detail` carries no remote output.
export interface StepReport {
  id: string;
  argv: string[];
  ok: boolean;
  detail: string;
}
