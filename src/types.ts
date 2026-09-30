export type Access = "observe" | "user" | "sudo-approved" | "full";
export type Auth = {
  type: "local-ssh-agent" | "bitwarden-ssh-agent" | "bitwarden-agent-access";
  socket?: string;
  item_id?: string;
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
  url: string;
  node: string;
  token_id: string;
  auth: Auth;
}
export interface Inventory {
  version: 1;
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
