// Public types for the secret request broker (Hiosdra/homelab#21 §5). Shapes
// that cross the contract (destination, field, request view, state) come from
// src/core/contracts.ts; everything broker-specific lives here.

import type {
  SecretDestination,
  SecretFieldKind,
  SecretRequestView,
} from "../core/contracts";

// In-memory values live for one hour from the moment they were provided.
// The window is absolute: using a value never extends it.
export const SECRET_VALUE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_REQUEST_TTL_MS = 15 * 60 * 1000;
export const MIN_REQUEST_TTL_MS = 60 * 1000;
export const MAX_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_CLIENT = 32;
export const MAX_FIELDS = 10;
export const MAX_PURPOSE_CHARS = 500;
export const MAX_VALUE_CHARS = 16_384;
export const MAX_HISTORY_RECORDS = 10_000;
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const SAVE_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,62}$/;
export const SECRET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
export const FIELD_KINDS: readonly SecretFieldKind[] = [
  "password",
  "token",
  "text",
  "ssh-key",
];

export type SecretRetention = "ephemeral" | "saved";

export interface SecretFieldInput {
  name: string;
  label?: string;
  // Defaults to "password" so that unknown forms are masked.
  kind?: SecretFieldKind;
}

export interface SecretRequestInput {
  client: string;
  task?: string;
  purpose: string;
  destination: SecretDestination;
  fields: SecretFieldInput[];
  requestTtlMs?: number;
  admin?: boolean;
}

// Metadata only. Values are never part of the vault meta.
export interface SecretVaultMeta {
  client: string;
  task?: string;
  destination: SecretDestination;
  fields: string[];
  createdAt: number;
}

// Persistent store for explicitly saved secrets. The broker never writes
// values anywhere else.
export interface VaultPort {
  save(
    name: string,
    values: Record<string, string>,
    meta: SecretVaultMeta,
  ): Promise<string>;
  load(secretId: string): Promise<Record<string, string> | undefined>;
}

// The request view plus the absolute expiry of any in-memory value. The
// contract's `expiresAt` stays the request (unanswered) expiry.
export interface BrokerRequestView extends SecretRequestView {
  valueExpiresAt?: number;
}

export interface SecretUseGrant {
  clients: string[];
  hosts: string[];
}

export interface SecretUseOptions {
  client: string;
  task?: string;
  destination: SecretDestination;
}

export interface SecretProvideOptions {
  retention: SecretRetention;
  saveName?: string;
}

export interface SecretRawHandoffOptions {
  client: string;
  stepUp: boolean;
  warningAcknowledged: boolean;
}

export type SecretHistoryAction =
  | "requested"
  | "provided"
  | "declined"
  | "cancelled"
  | "expired"
  | "revoked"
  | "used"
  | "raw-handoff";

// Metadata only: never a value, never requester text.
export interface SecretHistoryRecord {
  at: number;
  requestId?: string;
  ref?: string;
  client: string;
  action: SecretHistoryAction;
}

export interface SecretBrokerOptions {
  now: () => number;
  knownHost: (host: string) => boolean;
  vault?: VaultPort;
  // Injected for tests. Must return exactly `bytes` random bytes.
  random?: (bytes: number) => Uint8Array;
}
