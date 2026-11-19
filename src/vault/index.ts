// Embedded KDBX vault (0.3.0). Modules are kept small; import from here.
export {
  type CredentialKind,
  type CredentialSource,
  kdbxCredentials,
  passwordSource,
} from "./credentials";
export {
  createDatabase,
  type DatabaseOptions,
  openDatabase,
  type VaultDatabase,
} from "./kdbx";
export { inspectLegacy, type LegacyReport } from "./legacy";
export { VaultSession } from "./session";
export { exportTo, importFrom, type TransferResult } from "./transfer";
export type {
  Argon2Params,
  EntryKind,
  EntryMeta,
  LockReason,
  SessionOptions,
  SshKeyMaterial,
  VaultState,
} from "./types";
export { ADMIN_TAG } from "./types";
export {
  createUnattended,
  openUnattended,
  RestrictedSession,
  type UnattendedRequest,
  type UnattendedResult,
  unattendedKeySource,
} from "./unattended";
