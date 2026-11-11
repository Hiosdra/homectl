// Shared view types for the panel. They mirror the JSON the server returns.
export type Machine = {
  description: string;
  transport: string;
  address?: string;
  user?: string;
  access: string;
  auth?: unknown;
  [key: string]: unknown;
};
export type Permissions = {
  sync: boolean;
  diagnostics: boolean;
  operations: string[];
  administer: boolean;
};
export type Peer = {
  id: string;
  name: string;
  platform: string;
  address: string;
  permissions: Permissions;
};
export type State = {
  device: { id: string; name: string; platform: string };
  session: { unlocked: boolean; expiresAt?: number | null };
  vaultUnlocked: boolean;
  vaultExists: boolean;
  inventory: {
    machines: Record<string, Machine>;
    session?: { ttl: string; database: string; idle?: string };
  };
  peers: Peer[];
  pair: null | {
    code?: string;
    sas?: string;
    remote?: { name: string };
    expiresAt: number;
    localConfirmed: boolean;
    remoteConfirmed: boolean;
  };
  discovery: { devices: { id: string; address: string }[]; error?: string };
  pending: { id: string; peerId: string; remoteName: string }[];
  address: string;
  operations: {
    id: string;
    peerName: string;
    host: string;
    argv: string[];
    impact?: string;
  }[];
};
export type Preview = {
  id: string;
  localName: string;
  remoteName: string;
  blocker?: { type: "remote_vault_locked" };
  changes: string[];
  entries?: {
    id: string;
    local: { value: unknown; at?: number } | null;
    remote: { value: unknown; at?: number };
  }[];
  conflicts: {
    id: string;
    local: { value: unknown; at?: number };
    remote: { value: unknown; at?: number };
    // The later change; the person still chooses.
    suggested?: "local" | "remote";
  }[];
};
export type ControlOp = {
  operationId: string;
  state: string;
  host: string;
  classification: string;
  needsApproval: boolean;
  fingerprint: string;
  argv: string[];
  impact: string;
  issuer: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  expired: boolean;
  approval?: { approver: string; expiresAt: string; state: string };
  spawnAttempted: boolean;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  reason?: string;
  remote?: boolean;
  ownerName?: string;
  runsOn?: string;
  conflict?: boolean;
  takeover?: { possible: boolean; reason?: string; at?: string };
  delivery?: {
    decision: "approve" | "reject";
    status: "awaiting-confirmation" | "approved" | "rejected";
    ownerName: string;
    since: string;
  };
  approvedBy?: string;
  offerTo?: string;
  offerFrom?: string;
  offerExpires?: string;
};
export type ControlSync = {
  running: boolean;
  disabledBy?: string;
  peers: {
    id: string;
    name: string;
    lastSync?: number;
    leaseOk: boolean;
    excluded?: boolean;
    suspended?: { by: string; at: string; reason?: string };
    refused?: string;
    failures?: number;
    nextAttemptAt?: number;
    lastError?: string;
  }[];
  blocked: Record<string, string>;
  conflicts: { opId: string; epoch: number; candidates: string[] }[];
  resolutions?: {
    opId: string;
    conflictEpoch: number;
    winner: string;
    resolver: string;
    waitingForSelf?: boolean;
  }[];
  names?: Record<string, string>;
};
export type ControlDevices = {
  self: { id: string; name: string; fingerprint?: string };
  peers: { id: string; name: string; fingerprint?: string; legacy: boolean }[];
};
export type ControlAudit = {
  ok: boolean;
  entries: number;
  head: string;
  checkedAt?: string;
  error?: string;
};
export type ControlClient = {
  id: string;
  name: string;
  scopes: string[];
  hosts: string[];
  createdAt: string;
  revoked: boolean;
  oidc?: {
    issuerHost: string;
    claim: "sub" | "client_id";
    identityHash: string;
  };
  hasToken: boolean;
};
// Read-only view of the OIDC configuration (no secrets, no subjects).
export type OidcOverview = {
  issuer: string;
  issuerHost: string;
  audience: string;
  jwks: "configured" | "discovery";
  jwksHost?: string;
  maxLifetimeSeconds: number;
  keyCount: number;
  refreshedAt?: string;
  lastError?: string;
  mappedClients: number;
};
export type ControlOverview = {
  operations: ControlOp[];
  clients: ControlClient[];
  audit: ControlAudit;
  sync?: ControlSync;
  devices?: ControlDevices;
  oidc?: OidcOverview;
};
export type ControlExecution = {
  operation: ControlOp;
  output?: { stdout: string; stderr: string };
};
