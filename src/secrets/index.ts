// Secret request broker (homelab #21 §5). Public surface for the 0.3.0 secrets
// module: the broker, its ports and types, and the pure injection and redaction
// helpers.

export { SecretBroker } from "./broker";
export { destinationKey, normalizeDestination } from "./destinations";
export {
  type InjectionPlan,
  type InjectionStep,
  injectionPlan,
} from "./injection";
export { canaryLeaks, makeRedactor } from "./redaction";
export type {
  BrokerRequestView,
  SecretBrokerOptions,
  SecretFieldInput,
  SecretHistoryAction,
  SecretHistoryRecord,
  SecretProvideOptions,
  SecretRawHandoffOptions,
  SecretRequestInput,
  SecretRetention,
  SecretUseGrant,
  SecretUseOptions,
  SecretVaultMeta,
  VaultPort,
} from "./types";
export {
  DEFAULT_REQUEST_TTL_MS,
  MAX_PENDING_PER_CLIENT,
  SECRET_VALUE_TTL_MS,
} from "./types";
