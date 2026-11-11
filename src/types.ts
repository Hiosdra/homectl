export type Access = "observe" | "user" | "sudo-approved" | "full";
export type Auth = {
  type: "keepassxc";
  inventory?: string;
  socket: string;
  entry: string;
  public_key: string;
};
export interface Machine {
  description: string;
  transport: "local" | "ssh";
  access: Access;
  enforcement?: "advisory" | "sudoers";
  caution?: string[];
  ssh_alias?: string;
  address?: string;
  user?: string;
  port?: number;
  auth?: Auth;
  sudo_allow?: string[][];
}
export interface ProviderConfig {
  type: "proxmox";
  host: string;
  node: string;
  // Facts the guest catalogue checks against (all optional).
  vmid_range?: [number, number];
  // VMIDs that destroy always refuses.
  protected_vmids?: number[];
  storages?: string[];
  templates?: string[];
  // Optional Proxmox API transport. The token (KDBX entry: UserName is the token
  // id, Password is the secret) is loaded into the session agent at unlock and
  // lives only there, until the session expires or is locked.
  api?: { url: string; ca_file: string; token_entry: string };
}
export interface Inventory {
  version: 1;
  // ttl: how long the vault session lasts. idle: how long the panel may sit unused.
  session?: { ttl: string; database: string; idle?: string };
  machines: Record<string, Machine>;
  providers?: Record<string, ProviderConfig>;
}
export interface ExecutionPlan {
  host: string;
  machine: Machine;
  argv: string[];
  impact: string;
  classification: "inspect" | "mutation" | "destructive" | "opaque";
  approval: string;
  needsApproval: boolean;
}
export interface ProcessSpec {
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type Runner = (spec: ProcessSpec) => Promise<ProcessResult>;
export class HomectlError extends Error {
  constructor(
    public code: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
