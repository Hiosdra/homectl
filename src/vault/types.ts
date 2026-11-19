// Shared vault types. Metadata shapes never carry secret values.

export type EntryKind = "ssh-key" | "secret" | "api-token" | "other";

export const ADMIN_TAG = "homectl-admin";

export type EntryMeta = {
  id: string;
  name: string;
  group: string;
  kind: EntryKind;
  tags: string[];
  admin: boolean;
  updatedAt: number;
};

export type LockReason = "manual" | "absolute" | "idle" | "emergency";

export type VaultState = {
  unlocked: boolean;
  expiresAt: number | null;
  idleExpiresAt: number | null;
  privilegedUntil?: number;
};

export type SessionOptions = {
  now: () => number;
  absoluteTtlMs: number;
  idleTtlMs: number;
  privilegedTtlMs: number;
};

export type SshKeyMaterial = {
  privateKey: Uint8Array;
  publicKey: string;
};

export type Argon2Params = {
  memory: number; // KiB
  iterations: number;
  parallelism: number;
};
