// The ordered migration chain. Each step declares what it may touch, runs at
// most once per migration, and is verified right after it runs. Steps must be
// safe to re-run, because an interrupted migration is rolled back and started
// again from the backup.
import type { MigrationStep } from "./types";
import { carryAgentClients } from "./step-clients";
import { reportPreservedInPlace, verifyInventoryAndVault } from "./step-trust";
import { retirePendingAuthority, retireSigningAuthority } from "./step-state";

export const STEPS: readonly MigrationStep[] = [
  retirePendingAuthority,
  carryAgentClients,
  retireSigningAuthority,
  verifyInventoryAndVault,
  reportPreservedInPlace,
];
