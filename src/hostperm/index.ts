// Agentless host permission management (homectl 0.3.0, #21 C1-C3).

export { planAccount } from "./account";
export {
  type ApplyReport,
  type ApplyStatus,
  applyGrant,
  type RevokeReport,
  type RevokeStatus,
  revokeGrant,
} from "./apply";
export {
  addAuthorizedKey,
  editAddKey,
  editRemoveKey,
  type KeyReport,
  type KeyStatus,
  keyMaterial,
  keyTag,
  removeAuthorizedKey,
  validatePublicKey,
} from "./authorized-keys";
export {
  type BatchAction,
  type BatchHost,
  type BatchReviewItem,
  planBatch,
} from "./batch";
export {
  type DriftState,
  type DropInPlan,
  detectDrift,
  dropInPath,
  managedContent,
  parseManaged,
  planGrant,
  readRemoteFile,
  renderDropIn,
} from "./dropin";
export { detectPlatform, osFamily, parseOsRelease } from "./platform";
export type {
  AccountModel,
  AccountPlan,
  Grant,
  OsFamily,
  PlannedStep,
  Platform,
  RemoteExec,
  StepReport,
} from "./types";
